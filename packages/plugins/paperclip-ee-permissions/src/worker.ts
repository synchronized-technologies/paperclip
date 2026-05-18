import {
  definePlugin,
  runWorker,
  PLUGIN_RPC_ERROR_CODES,
  type HumanCompanyMembershipRole,
  type MembershipStatus,
  type PluginAccessMember,
  type PluginAuthorizationAuditEntry,
  type PluginAuthorizationPolicySummary,
  type PluginContext,
  type Issue,
  type PermissionKey,
  type PrincipalPermissionGrant,
} from "@paperclipai/plugin-sdk";

const LICENSE_STATE_SCOPE = "company";
const LICENSE_STATE_KEY = "license";

/**
 * Worker-visible license state. Phase 3A scaffolds a deterministic stub:
 * the plugin defaults to "unlicensed" unless an operator has explicitly
 * activated the EE permissions mode for the company. Later phases replace
 * this with a real license check tied to a core-owned advanced-mode flag.
 */
export type EePermissionsLicense = {
  status: "active" | "inactive";
  activatedAt?: string;
  activatedByUserId?: string | null;
  note?: string | null;
};

const DEFAULT_LICENSE: EePermissionsLicense = { status: "inactive" };

/**
 * Shape returned by `getData("overview", { companyId })`. The UI uses this
 * as the single source of truth for whether to render the advanced controls
 * or one of the deterministic missing-state fallbacks.
 */
export type EePermissionsOverview = {
  companyId: string;
  license: EePermissionsLicense;
  policySummary: PluginAuthorizationPolicySummary | null;
  warnings: Array<{ code: string; message: string }>;
};

type AssignmentGrantMode = "broad" | "scoped_agent" | "clear";

const HUMAN_ROLE_VALUES: readonly HumanCompanyMembershipRole[] = ["owner", "admin", "operator", "viewer"];
const MEMBER_EDITABLE_STATUSES: ReadonlyArray<Extract<MembershipStatus, "pending" | "active" | "suspended">> = [
  "pending",
  "active",
  "suspended",
];
const NON_MEMBER_PERMISSION_KEYS: ReadonlySet<PermissionKey> = new Set([
  "tasks:assign_scope",
]);

export type EePermissionsMemberAccessData = {
  companyId: string;
  warnings: Array<{ code: string; message: string }>;
  members: PluginAccessMember[];
  agents: Awaited<ReturnType<PluginContext["agents"]["list"]>>;
};

export type EePermissionsAdvancedPolicyData = {
  companyId: string;
  summary: PluginAuthorizationPolicySummary | null;
  warnings: Array<{ code: string; message: string }>;
  agents: Awaited<ReturnType<PluginContext["agents"]["list"]>>;
  issues: Issue[];
  selected: {
    actorAgentId: string | null;
    targetAgentId: string | null;
    projectId: string | null;
    issueId: string | null;
  };
  agentPolicy: Awaited<ReturnType<PluginContext["authorization"]["policies"]["get"]>>;
  actorGrants: PrincipalPermissionGrant[];
  preview: Awaited<ReturnType<PluginContext["authorization"]["policies"]["previewAssignment"]>> | null;
  explanation: Awaited<ReturnType<PluginContext["authorization"]["policies"]["explainAssignment"]>> | null;
  auditEntries: PluginAuthorizationAuditEntry[];
};

function readCompanyId(params: Record<string, unknown>): string {
  const value = params.companyId;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("companyId is required");
  }
  return value;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value : "";
}

function readBoolean(params: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = params[key];
  return typeof value === "boolean" ? value : fallback;
}

function readGrantMode(value: unknown): AssignmentGrantMode {
  if (value === "broad" || value === "scoped_agent" || value === "clear") return value;
  return "scoped_agent";
}

function readHumanRole(value: unknown): HumanCompanyMembershipRole | null {
  if (value === null) return null;
  if (typeof value !== "string") return null;
  if (value === "") return null;
  return (HUMAN_ROLE_VALUES as readonly string[]).includes(value)
    ? (value as HumanCompanyMembershipRole)
    : null;
}

function readEditableStatus(value: unknown): Extract<MembershipStatus, "pending" | "active" | "suspended"> {
  if (typeof value === "string" && (MEMBER_EDITABLE_STATUSES as readonly string[]).includes(value)) {
    return value as Extract<MembershipStatus, "pending" | "active" | "suspended">;
  }
  return "active";
}

function readPermissionKeyArray(value: unknown): PermissionKey[] {
  if (!Array.isArray(value)) return [];
  const out: PermissionKey[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && !out.includes(entry as PermissionKey)) {
      out.push(entry as PermissionKey);
    }
  }
  return out;
}

function withoutAssignmentGrants(grants: PrincipalPermissionGrant[]) {
  return grants
    .filter((grant) => grant.permissionKey !== "tasks:assign" && grant.permissionKey !== "tasks:assign_scope")
    .map((grant) => ({
      permissionKey: grant.permissionKey as PermissionKey,
      scope: grant.scope && typeof grant.scope === "object" ? grant.scope as Record<string, unknown> : null,
    }));
}

function isCapabilityDenied(error: unknown): boolean {
  if (!error) return false;
  const code = (error as { code?: unknown }).code;
  if (code === PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED) return true;
  if (code === "CAPABILITY_DENIED") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /missing required capability/i.test(message);
}

function formatError(error: unknown): { code: string; message: string } {
  if (isCapabilityDenied(error)) {
    return {
      code: "CAPABILITY_DENIED",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    code: "WORKER_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function readLicense(
  ctx: PluginContext,
  companyId: string,
): Promise<EePermissionsLicense> {
  const value = (await ctx.state.get({
    scopeKind: LICENSE_STATE_SCOPE,
    scopeId: companyId,
    stateKey: LICENSE_STATE_KEY,
  })) as EePermissionsLicense | null;
  if (!value || typeof value !== "object") return DEFAULT_LICENSE;
  return value.status === "active" ? value : DEFAULT_LICENSE;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("overview", async (params) => {
      const companyId = readCompanyId(params ?? {});
      const license = await readLicense(ctx, companyId);
      const warnings: EePermissionsOverview["warnings"] = [];
      if (license.status !== "active") {
        return {
          companyId,
          license,
          policySummary: null,
          warnings,
        } satisfies EePermissionsOverview;
      }
      let policySummary: PluginAuthorizationPolicySummary | null = null;
      try {
        policySummary = await ctx.authorization.policies.summary(companyId);
      } catch (error) {
        warnings.push(formatError(error));
      }
      return {
        companyId,
        license,
        policySummary,
        warnings,
      } satisfies EePermissionsOverview;
    });

    ctx.data.register("members", async (params) => {
      const companyId = readCompanyId(params ?? {});
      const license = await readLicense(ctx, companyId);
      if (license.status !== "active") return [] as PluginAccessMember[];
      try {
        return await ctx.access.members.list({ companyId });
      } catch (error) {
        if (isCapabilityDenied(error)) return [] as PluginAccessMember[];
        throw error;
      }
    });

    ctx.data.register("memberAccess", async (params) => {
      const companyId = readCompanyId(params ?? {});
      const license = await readLicense(ctx, companyId);
      if (license.status !== "active") {
        return {
          companyId,
          warnings: [],
          members: [],
          agents: [],
        } satisfies EePermissionsMemberAccessData;
      }
      const warnings: EePermissionsMemberAccessData["warnings"] = [];
      let members: PluginAccessMember[] = [];
      let agents: EePermissionsMemberAccessData["agents"] = [];
      try {
        members = await ctx.access.members.list({ companyId });
      } catch (error) {
        warnings.push(formatError(error));
      }
      try {
        agents = await ctx.agents.list({ companyId, limit: 200, offset: 0 });
      } catch (error) {
        warnings.push(formatError(error));
      }
      return { companyId, warnings, members, agents } satisfies EePermissionsMemberAccessData;
    });

    ctx.data.register("grants", async (params) => {
      const input = params ?? {};
      const companyId = readCompanyId(input);
      const license = await readLicense(ctx, companyId);
      if (license.status !== "active") return [] as PrincipalPermissionGrant[];
      try {
        return await ctx.authorization.grants.list({
          companyId,
          principalType: readStringOrUndefined(input.principalType) as
            | PrincipalPermissionGrant["principalType"]
            | undefined,
          principalId: readStringOrUndefined(input.principalId),
        });
      } catch (error) {
        if (isCapabilityDenied(error)) return [] as PrincipalPermissionGrant[];
        throw error;
      }
    });

    ctx.data.register("audit", async (params) => {
      const input = params ?? {};
      const companyId = readCompanyId(input);
      const license = await readLicense(ctx, companyId);
      if (license.status !== "active") return [] as PluginAuthorizationAuditEntry[];
      try {
        return await ctx.authorization.audit.search({
          companyId,
          action: readStringOrUndefined(input.action),
          actorType: readStringOrUndefined(input.actorType),
          actorId: readStringOrUndefined(input.actorId),
          entityType: readStringOrUndefined(input.entityType),
          entityId: readStringOrUndefined(input.entityId),
          decision: readStringOrUndefined(input.decision),
          limit: readNumber(input.limit, 25),
          offset: readNumber(input.offset, 0),
        });
      } catch (error) {
        if (isCapabilityDenied(error)) return [] as PluginAuthorizationAuditEntry[];
        throw error;
      }
    });

    ctx.data.register("advancedPolicy", async (params) => {
      const input = params ?? {};
      const companyId = readCompanyId(input);
      const license = await readLicense(ctx, companyId);
      if (license.status !== "active") {
        return {
          companyId,
          summary: null,
          warnings: [],
          agents: [],
          issues: [],
          selected: {
            actorAgentId: null,
            targetAgentId: null,
            projectId: null,
            issueId: null,
          },
          agentPolicy: null,
          actorGrants: [],
          preview: null,
          explanation: null,
          auditEntries: [],
        } satisfies EePermissionsAdvancedPolicyData;
      }

      const warnings: EePermissionsAdvancedPolicyData["warnings"] = [];
      const [summary, agents, issues] = await Promise.all([
        ctx.authorization.policies.summary(companyId).catch((error) => {
          warnings.push(formatError(error));
          return null;
        }),
        ctx.agents.list({ companyId, limit: 200, offset: 0 }).catch((error) => {
          warnings.push(formatError(error));
          return [];
        }),
        ctx.issues.list({ companyId, limit: 100, offset: 0 }).catch((error) => {
          warnings.push(formatError(error));
          return [] as Issue[];
        }),
      ]);
      const actorAgent = agents.find((agent) => agent.id === readString(input, "actorAgentId")) ?? agents[0] ?? null;
      const targetAgent = agents.find((agent) => agent.id === readString(input, "targetAgentId"))
        ?? agents.find((agent) => agent.id !== actorAgent?.id)
        ?? agents[0]
        ?? null;
      const selectedProjectId = readString(input, "projectId") || null;
      const selectedIssueId = readString(input, "issueId") || null;
      const [agentPolicy, actorGrants, preview, explanation, auditEntries] = await Promise.all([
        targetAgent
          ? ctx.authorization.policies.get({ companyId, resourceType: "agent", resourceId: targetAgent.id }).catch((error) => {
            warnings.push(formatError(error));
            return null;
          })
          : Promise.resolve(null),
        actorAgent
          ? ctx.authorization.grants.list({ companyId, principalType: "agent", principalId: actorAgent.id }).catch((error) => {
            warnings.push(formatError(error));
            return [] as PrincipalPermissionGrant[];
          })
          : Promise.resolve([] as PrincipalPermissionGrant[]),
        actorAgent && targetAgent
          ? ctx.authorization.policies.previewAssignment({
            companyId,
            actor: { type: "agent", agentId: actorAgent.id, companyId },
            target: {
              issueId: selectedIssueId,
              projectId: selectedProjectId,
              assigneeAgentId: targetAgent.id,
            },
          }).catch((error) => {
            warnings.push(formatError(error));
            return null;
          })
          : Promise.resolve(null),
        actorAgent && targetAgent
          ? ctx.authorization.policies.explainAssignment({
            companyId,
            actor: { type: "agent", agentId: actorAgent.id, companyId },
            target: {
              issueId: selectedIssueId,
              projectId: selectedProjectId,
              assigneeAgentId: targetAgent.id,
            },
          }).catch((error) => {
            warnings.push(formatError(error));
            return null;
          })
          : Promise.resolve(null),
        ctx.authorization.audit.search({
          companyId,
          action: readStringOrUndefined(input.action),
          actorType: readStringOrUndefined(input.actorType),
          actorId: readStringOrUndefined(input.actorId),
          entityType: readStringOrUndefined(input.entityType),
          entityId: readStringOrUndefined(input.entityId),
          decision: readStringOrUndefined(input.decision),
          limit: 25,
          offset: 0,
        }).catch((error) => {
          warnings.push(formatError(error));
          return [] as PluginAuthorizationAuditEntry[];
        }),
      ]);

      return {
        companyId,
        summary,
        warnings,
        agents,
        issues,
        selected: {
          actorAgentId: actorAgent?.id ?? null,
          targetAgentId: targetAgent?.id ?? null,
          projectId: selectedProjectId,
          issueId: selectedIssueId,
        },
        agentPolicy,
        actorGrants,
        preview,
        explanation,
        auditEntries,
      } satisfies EePermissionsAdvancedPolicyData;
    });

    ctx.actions.register("activateLicense", async (params) => {
      const input = params ?? {};
      const companyId = readCompanyId(input);
      const license: EePermissionsLicense = {
        status: "active",
        activatedAt: new Date().toISOString(),
        activatedByUserId: readStringOrUndefined(input.activatedByUserId) ?? null,
        note: readStringOrUndefined(input.note) ?? null,
      };
      await ctx.state.set(
        {
          scopeKind: LICENSE_STATE_SCOPE,
          scopeId: companyId,
          stateKey: LICENSE_STATE_KEY,
        },
        license,
      );
      return license;
    });

    ctx.actions.register("deactivateLicense", async (params) => {
      const companyId = readCompanyId(params ?? {});
      await ctx.state.delete({
        scopeKind: LICENSE_STATE_SCOPE,
        scopeId: companyId,
        stateKey: LICENSE_STATE_KEY,
      });
      return DEFAULT_LICENSE;
    });

    ctx.actions.register("saveMemberAccess", async (params) => {
      const input = params ?? {};
      const companyId = readCompanyId(input);
      const license = await readLicense(ctx, companyId);
      if (license.status !== "active") {
        throw new Error("Paperclip EE permissions mode is not active for this company");
      }
      const memberId = readString(input, "memberId");
      if (!memberId) throw new Error("memberId is required");
      const member = await ctx.access.members.get(memberId, companyId);
      if (!member) throw new Error(`Membership not found: ${memberId}`);
      const membershipRole = readHumanRole(input.membershipRole);
      const status = readEditableStatus(input.status);
      const explicitGrants = readPermissionKeyArray(input.grants)
        .filter((key) => !NON_MEMBER_PERMISSION_KEYS.has(key));

      const updatedMember = await ctx.access.members.update(
        memberId,
        { membershipRole, status },
        companyId,
      );

      const existing = await ctx.authorization.grants.list({
        companyId,
        principalType: member.principalType,
        principalId: member.principalId,
      });
      const carriedOverNonMemberGrants = existing
        .filter((grant) => NON_MEMBER_PERMISSION_KEYS.has(grant.permissionKey as PermissionKey))
        .map((grant) => ({
          permissionKey: grant.permissionKey as PermissionKey,
          scope: grant.scope && typeof grant.scope === "object" ? grant.scope as Record<string, unknown> : null,
        }));
      const nextGrants = [
        ...explicitGrants.map((permissionKey) => ({ permissionKey, scope: null as Record<string, unknown> | null })),
        ...carriedOverNonMemberGrants,
      ];

      const grants = await ctx.authorization.grants.set({
        companyId,
        principalType: member.principalType,
        principalId: member.principalId,
        grants: nextGrants,
      });

      return {
        member: { ...updatedMember, grants },
      };
    });

    ctx.actions.register("saveAgentPolicy", async (params) => {
      const input = params ?? {};
      const companyId = readCompanyId(input);
      const license = await readLicense(ctx, companyId);
      if (license.status !== "active") throw new Error("Paperclip EE permissions mode is not active for this company");
      const agentId = readString(input, "agentId");
      if (!agentId) throw new Error("agentId is required");
      const visibilityMode = readString(input, "visibilityMode") === "private" ? "private" : "discoverable";
      const assignmentMode = readString(input, "assignmentMode") === "protected" ? "protected" : "company_default";
      const approvalReason = readString(input, "approvalReason").trim();
      return await ctx.authorization.policies.update({
        companyId,
        resourceType: "agent",
        resourceId: agentId,
        policy: {
          agentVisibility: {
            mode: visibilityMode,
            hiddenFromDefaultDirectory: visibilityMode === "private",
          },
          assignmentPolicy: {
            mode: assignmentMode,
            protectedAgentRequiresApproval: assignmentMode === "protected",
          },
          protectedAgent: {
            requiresApproval: readBoolean(input, "requiresApproval", assignmentMode === "protected"),
            approvalReason: approvalReason || null,
          },
          managedBy: "paperclip-ee-permissions",
        },
      });
    });

    ctx.actions.register("saveAssignmentGrant", async (params) => {
      const input = params ?? {};
      const companyId = readCompanyId(input);
      const license = await readLicense(ctx, companyId);
      if (license.status !== "active") throw new Error("Paperclip EE permissions mode is not active for this company");
      const actorAgentId = readString(input, "actorAgentId");
      const targetAgentId = readString(input, "targetAgentId");
      const projectId = readString(input, "projectId");
      const mode = readGrantMode(input.mode);
      if (!actorAgentId) throw new Error("actorAgentId is required");
      const existing = await ctx.authorization.grants.list({
        companyId,
        principalType: "agent",
        principalId: actorAgentId,
      });
      const grants = withoutAssignmentGrants(existing);
      if (mode === "broad") {
        grants.push({ permissionKey: "tasks:assign", scope: null });
      } else if (mode === "scoped_agent") {
        if (!targetAgentId) throw new Error("targetAgentId is required for scoped assignment grants");
        grants.push({
          permissionKey: "tasks:assign_scope",
          scope: {
            assigneeAgentId: targetAgentId,
            ...(projectId ? { projectId } : {}),
          },
        });
      }
      return await ctx.authorization.grants.set({
        companyId,
        principalType: "agent",
        principalId: actorAgentId,
        grants,
      });
    });
  },

  async onHealth() {
    return { status: "ok", message: "Paperclip EE Permissions worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
