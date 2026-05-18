import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  AssigneePicker,
  DataTable,
  ErrorBoundary,
  JsonTree,
  KeyValueList,
  MetricCard,
  ProjectPicker,
  Spinner,
  StatusBadge,
  useHostContext,
  usePluginAction,
  usePluginData,
  type DataTableColumn,
  type PluginCompanySettingsPageProps,
  type StatusBadgeVariant,
} from "@paperclipai/plugin-sdk/ui";

type HumanCompanyMembershipRole = "owner" | "admin" | "operator" | "viewer";
type MemberEditableStatus = "pending" | "active" | "suspended";
type MemberPrincipalType = "user" | "agent";
type PermissionKey =
  | "agents:create"
  | "environments:manage"
  | "users:invite"
  | "users:manage_permissions"
  | "tasks:assign"
  | "tasks:assign_scope"
  | "tasks:manage_active_checkouts"
  | "joins:approve";

const HUMAN_ROLE_LABELS: Record<HumanCompanyMembershipRole, string> = {
  owner: "Owner",
  admin: "Admin",
  operator: "Operator",
  viewer: "Viewer",
};

const MEMBER_PERMISSION_KEYS: ReadonlyArray<PermissionKey> = [
  "agents:create",
  "users:invite",
  "users:manage_permissions",
  "tasks:assign",
  "tasks:manage_active_checkouts",
  "joins:approve",
  "environments:manage",
];

const PERMISSION_LABELS: Record<PermissionKey, string> = {
  "agents:create": "Create agents",
  "users:invite": "Invite humans and agents",
  "users:manage_permissions": "Manage members and grants",
  "tasks:assign": "Assign tasks",
  "tasks:assign_scope": "Assign scoped tasks",
  "tasks:manage_active_checkouts": "Manage active task checkouts",
  "joins:approve": "Approve join requests",
  "environments:manage": "Manage environments",
};

const IMPLICIT_ROLE_GRANTS: Record<HumanCompanyMembershipRole, PermissionKey[]> = {
  owner: ["agents:create", "users:invite", "users:manage_permissions", "tasks:assign", "joins:approve"],
  admin: ["agents:create", "users:invite", "tasks:assign", "joins:approve"],
  operator: ["tasks:assign"],
  viewer: [],
};

type MemberRecord = {
  id: string;
  companyId: string;
  principalType: MemberPrincipalType;
  principalId: string;
  status: MemberEditableStatus | "archived";
  membershipRole: HumanCompanyMembershipRole | string | null;
  grants: Array<{ permissionKey: string; scope: Record<string, unknown> | null }>;
};

type AgentRecord = {
  id: string;
  name: string;
  role?: string | null;
  title?: string | null;
  status?: string | null;
};

type MemberAccessData = {
  companyId: string;
  warnings: Array<{ code: string; message: string }>;
  members: MemberRecord[];
  agents?: AgentRecord[];
};

type LicenseState = {
  status: "active" | "inactive";
  activatedAt?: string;
  activatedByUserId?: string | null;
  note?: string | null;
};

type PolicySummary = {
  companyId: string;
  permissionsMode: "simple";
  memberCount: number;
  activeMemberCount: number;
  grantCount: number;
  advancedPolicyAvailable: false;
};

type IssueRecord = {
  id: string;
  title: string;
  status: string;
  projectId?: string | null;
};

type DecisionRecord = {
  allowed: boolean;
  action: string;
  explanation: string;
  reason: string;
  grant?: {
    permissionKey: string;
    scope: Record<string, unknown> | null;
  };
};

type Overview = {
  companyId: string;
  license: LicenseState;
  policySummary: PolicySummary | null;
  warnings: Array<{ code: string; message: string }>;
};

type AuditEntry = {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown> | null;
  createdAt: string;
};

type AdvancedPolicyData = {
  companyId: string;
  summary: PolicySummary | null;
  warnings: Overview["warnings"];
  agents: AgentRecord[];
  issues: IssueRecord[];
  selected: {
    actorAgentId: string | null;
    targetAgentId: string | null;
    projectId: string | null;
    issueId: string | null;
  };
  agentPolicy: {
    resourceType: string;
    resourceId: string;
    policy: Record<string, unknown> | null;
    updatedAt: string | null;
  } | null;
  actorGrants: Array<{
    permissionKey: string;
    scope: Record<string, unknown> | null;
  }>;
  preview: DecisionRecord | null;
  explanation: DecisionRecord | null;
  auditEntries: AuditEntry[];
};

const layoutStack: CSSProperties = {
  display: "grid",
  gap: "16px",
  padding: "24px 0",
};

const cardStyle: CSSProperties = {
  border: "1px solid var(--border, #e2e8f0)",
  borderRadius: "8px",
  padding: "16px",
  display: "grid",
  gap: "12px",
  background: "var(--card, #ffffff)",
};

const subtleCardStyle: CSSProperties = {
  border: "1px solid var(--border, #e2e8f0)",
  borderRadius: "8px",
  padding: "12px",
  display: "grid",
  gap: "8px",
  background: "var(--background, transparent)",
};

const mutedTextStyle: CSSProperties = {
  color: "var(--muted-foreground, #64748b)",
  fontSize: "0.9rem",
  lineHeight: 1.5,
};

const sectionHeadingStyle: CSSProperties = {
  fontSize: "0.75rem",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--muted-foreground, #64748b)",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "8px",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gap: "12px",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
};

const inputStyle: CSSProperties = {
  width: "100%",
  border: "1px solid var(--border, #cbd5e1)",
  borderRadius: "6px",
  padding: "8px 10px",
  background: "var(--background, transparent)",
  color: "inherit",
  fontSize: "0.85rem",
};

const buttonStyle: CSSProperties = {
  padding: "7px 12px",
  borderRadius: "6px",
  border: "1px solid var(--border, #cbd5e1)",
  background: "var(--background, transparent)",
  color: "inherit",
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--foreground, #0f172a)",
  color: "var(--background, #ffffff)",
};

const warningStyle: CSSProperties = {
  border: "1px solid var(--warning-border, #facc15)",
  background: "var(--warning-muted, #fefce8)",
  borderRadius: "8px",
  padding: "10px 12px",
  color: "var(--warning-foreground, #713f12)",
};

const fieldStyle: CSSProperties = {
  display: "grid",
  gap: "6px",
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusForDecision(allowed: boolean): StatusBadgeVariant {
  return allowed ? "ok" : "error";
}

function decisionLabel(allowed: boolean): string {
  return allowed ? "✓ Allowed" : "✕ Denied";
}

function membershipStatusVariant(status: string): StatusBadgeVariant {
  if (status === "active") return "ok";
  if (status === "pending") return "pending";
  if (status === "suspended" || status === "archived") return "warning";
  return "info";
}

function formatPermission(permissionKey: string): string {
  return PERMISSION_LABELS[permissionKey as PermissionKey] ?? permissionKey;
}

function formatScope(scope: Record<string, unknown> | null | undefined): string {
  if (!scope || Object.keys(scope).length === 0) return "Any scope";
  const parts = Object.entries(scope).map(([key, value]) => `${key}: ${String(value)}`);
  return parts.join(", ");
}

function formatMode(value: string | null | undefined): string {
  if (!value) return "Not set";
  return value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function getPolicySection(policy: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> {
  const value = policy?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function getPolicyString(policy: Record<string, unknown> | null | undefined, section: string, key: string, fallback: string) {
  const value = getPolicySection(policy, section)[key];
  return typeof value === "string" ? value : fallback;
}

function getPolicyBoolean(policy: Record<string, unknown> | null | undefined, section: string, key: string, fallback: boolean) {
  const value = getPolicySection(policy, section)[key];
  return typeof value === "boolean" ? value : fallback;
}

function RawDisclosure({ label = "Raw response", data }: { label?: string; data: unknown }) {
  return (
    <details>
      <summary style={{ ...mutedTextStyle, cursor: "pointer" }}>{label}</summary>
      <JsonTree data={data} defaultExpandDepth={1} />
    </details>
  );
}

function CapabilityWarning({ warnings }: { warnings: Overview["warnings"] }) {
  if (warnings.length === 0) return null;
  const denied = warnings.some((warning) => warning.code === "CAPABILITY_DENIED");
  return (
    <div style={warningStyle}>
      <strong>{denied ? "Some advanced data is unavailable." : "Some advanced data could not be loaded."}</strong>
      <div style={mutedTextStyle}>
        {denied
          ? "The plugin is missing one or more capability grants. Install the latest version or re-activate the plugin to restore the missing surfaces."
          : "Existing restrictions remain enforced by core. Retry once the underlying service is reachable."}
      </div>
      <ul style={{ margin: "6px 0 0", paddingLeft: "18px" }}>
        {warnings.map((warning, index) => (
          <li key={`${warning.code}-${index}`}>
            <code>{warning.code}</code>: {warning.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div style={rowStyle}>
      <Spinner size="sm" label={label} />
      <span style={mutedTextStyle}>{label}</span>
    </div>
  );
}

function MissingCompanyState() {
  return (
    <div style={layoutStack}>
      <div style={cardStyle}>
        <div style={sectionHeadingStyle}>Permissions</div>
        <strong>No active company</strong>
        <div style={mutedTextStyle}>Switch into a company to manage advanced permissions.</div>
      </div>
    </div>
  );
}

function UnlicensedState({
  companyId,
  onActivate,
  activating,
}: {
  companyId: string;
  onActivate: () => void;
  activating: boolean;
}) {
  return (
    <div style={layoutStack}>
      <div style={cardStyle}>
        <div style={sectionHeadingStyle}>Paperclip EE Permissions</div>
        <strong>Advanced permissions mode is not active</strong>
        <div style={mutedTextStyle}>
          Members can collaborate across this company by default. Activate Paperclip EE permissions to unlock scoped grants, protected-agent controls, assignment previews, and audit filters.
        </div>
        <div>
          <button type="button" style={buttonStyle} disabled={activating} onClick={onActivate}>
            {activating ? <LoadingState label="Activating" /> : "Activate for this company"}
          </button>
        </div>
        <KeyValueList pairs={[{ label: "Company", value: <code>{companyId}</code> }]} />
      </div>
    </div>
  );
}

type PrincipalProfile = {
  label: string;
  secondary: string;
};

function profileForPrincipal(member: MemberRecord, agents: AgentRecord[]): PrincipalProfile {
  if (member.principalType === "agent") {
    const agent = agents.find((entry) => entry.id === member.principalId);
    if (agent) {
      return {
        label: agent.name,
        secondary: [agent.title || agent.role, agent.status, agent.id].filter(Boolean).join(" / "),
      };
    }
    return {
      label: "Agent",
      secondary: member.principalId,
    };
  }
  if (member.principalId.includes("@")) {
    const [localPart] = member.principalId.split("@");
    return {
      label: localPart.split(/[._-]/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") || member.principalId,
      secondary: member.principalId,
    };
  }
  return {
    label: "Board user",
    secondary: member.principalId,
  };
}

type MemberTableRow = {
  id: string;
  member: MemberRecord;
  principal: ReactNode;
  role: ReactNode;
  status: ReactNode;
  grants: ReactNode;
  action: ReactNode;
};

function MembersPanel({ companyId }: { companyId: string }) {
  const query = usePluginData<MemberAccessData>("memberAccess", { companyId });
  const saveMemberAccess = usePluginAction("saveMemberAccess");
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [draftRole, setDraftRole] = useState<HumanCompanyMembershipRole | "">("");
  const [draftStatus, setDraftStatus] = useState<MemberEditableStatus>("active");
  const [draftGrants, setDraftGrants] = useState<Set<PermissionKey>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const members = query.data?.members ?? [];
  const agents = query.data?.agents ?? [];
  const editingMember = useMemo(
    () => members.find((member) => member.id === editingMemberId) ?? null,
    [members, editingMemberId],
  );
  const editingProfile = editingMember ? profileForPrincipal(editingMember, agents) : null;
  const implicitGrantKeys = useMemo<PermissionKey[]>(
    () => (draftRole ? IMPLICIT_ROLE_GRANTS[draftRole] : []),
    [draftRole],
  );

  useEffect(() => {
    if (!editingMember) return;
    const role = editingMember.membershipRole;
    setDraftRole((role && role in HUMAN_ROLE_LABELS ? (role as HumanCompanyMembershipRole) : ""));
    setDraftStatus(
      editingMember.status === "active" || editingMember.status === "pending" || editingMember.status === "suspended"
        ? editingMember.status
        : "suspended",
    );
    setDraftGrants(new Set(editingMember.grants.map((grant) => grant.permissionKey as PermissionKey)));
    setError(null);
  }, [editingMember]);

  if (query.loading && !query.data) {
    return <LoadingState label="Loading members" />;
  }

  if (query.error) {
    return (
      <div style={warningStyle}>
        <strong>Could not load company members.</strong>
        <div>{query.error.message}</div>
      </div>
    );
  }

  const pendingHumans = members.filter((member) => member.principalType === "user" && member.status === "pending");
  const activeHumans = members.filter((member) => member.principalType === "user" && member.status !== "pending");
  const agentMembers = members.filter((member) => member.principalType === "agent");
  const closeEditor = () => {
    setEditingMemberId(null);
    setError(null);
  };

  async function save() {
    if (!editingMember) return;
    setBusy(true);
    setError(null);
    try {
      await saveMemberAccess({
        companyId,
        memberId: editingMember.id,
        membershipRole: draftRole || null,
        status: draftStatus,
        grants: [...draftGrants],
      });
      query.refresh();
      setEditingMemberId(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={layoutStack}>
      <CapabilityWarning warnings={query.data?.warnings ?? []} />

      <div style={cardStyle}>
        <div style={{ ...rowStyle, justifyContent: "space-between" }}>
          <div>
            <div style={sectionHeadingStyle}>Members</div>
            <strong>Company access</strong>
          </div>
          <button type="button" style={buttonStyle} onClick={() => query.refresh()}>Refresh</button>
        </div>
        <div style={mutedTextStyle}>
          Roles, membership status, and explicit permission grants for humans and agents in this company.
        </div>
        {members.length === 0 ? (
          <div style={mutedTextStyle}>No company members yet.</div>
        ) : null}
        <MembersTable
          members={pendingHumans}
          agents={agents}
          label="Pending humans"
          emptyLabel="No pending join requests"
          onEdit={setEditingMemberId}
        />
        <MembersTable
          members={activeHumans}
          agents={agents}
          label="Humans"
          emptyLabel="No active human members"
          onEdit={setEditingMemberId}
        />
        <MembersTable
          members={agentMembers}
          agents={agents}
          label="Agents"
          emptyLabel="No agent members"
          onEdit={setEditingMemberId}
        />
      </div>

      {editingMember && editingProfile ? (
        <div style={cardStyle}>
          <div style={rowStyle}>
            <div style={sectionHeadingStyle}>Editing member</div>
            <StatusBadge label={editingMember.principalType === "agent" ? "Agent" : "Human"} status="info" />
          </div>
          <strong>{editingProfile.label}</strong>
          <div style={mutedTextStyle}>{editingProfile.secondary}</div>

          <div style={gridStyle}>
            <label style={fieldStyle}>
              <span style={sectionHeadingStyle}>Company role</span>
              <select
                style={inputStyle}
                value={draftRole}
                onChange={(event) => setDraftRole(event.target.value as HumanCompanyMembershipRole | "")}
              >
                <option value="">Unset</option>
                {Object.entries(HUMAN_ROLE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label style={fieldStyle}>
              <span style={sectionHeadingStyle}>Membership status</span>
              <select
                style={inputStyle}
                value={draftStatus}
                onChange={(event) => setDraftStatus(event.target.value as MemberEditableStatus)}
              >
                <option value="active">Active</option>
                <option value="pending">Pending</option>
                <option value="suspended">Suspended</option>
              </select>
            </label>
          </div>

          <div style={subtleCardStyle}>
            <div style={rowStyle}>
              <strong>Implicit grants from role</strong>
              <StatusBadge label={draftRole ? HUMAN_ROLE_LABELS[draftRole] : "No role"} status={draftRole ? "info" : "pending"} />
            </div>
            <div style={mutedTextStyle}>
              {draftRole
                ? `${HUMAN_ROLE_LABELS[draftRole]} already includes these permissions automatically.`
                : "No role selected, so this member has no implicit grants right now."}
            </div>
            {implicitGrantKeys.length > 0 ? (
              <div style={rowStyle}>
                {implicitGrantKeys.map((permissionKey) => (
                  <StatusBadge key={permissionKey} label={PERMISSION_LABELS[permissionKey]} status="info" />
                ))}
              </div>
            ) : null}
          </div>

          <div>
            <div style={sectionHeadingStyle}>Explicit grants</div>
            <div style={mutedTextStyle}>
              Explicit grants persist when the role changes. Scoped assignment grants are managed in the policy editor below.
            </div>
            <div style={{ ...gridStyle, marginTop: "8px" }}>
              {MEMBER_PERMISSION_KEYS.map((permissionKey) => {
                const isImplicit = implicitGrantKeys.includes(permissionKey);
                const isChecked = draftGrants.has(permissionKey);
                return (
                  <div key={permissionKey} style={subtleCardStyle}>
                    <label style={{ ...rowStyle, gap: "10px" }}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(event) => {
                          setDraftGrants((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(permissionKey);
                            else next.delete(permissionKey);
                            return next;
                          });
                        }}
                      />
                      <span>
                        <strong>{PERMISSION_LABELS[permissionKey]}</strong>
                        <div style={{ ...mutedTextStyle, fontSize: "0.72rem" }}>
                          <code>{permissionKey}</code>
                        </div>
                      </span>
                    </label>
                    {isImplicit && !isChecked ? (
                      <div style={mutedTextStyle}>Included implicitly by the {draftRole ? HUMAN_ROLE_LABELS[draftRole] : "selected"} role.</div>
                    ) : null}
                    {isChecked ? (
                      <div style={mutedTextStyle}>Stored explicitly for this member.</div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          {error ? <div style={warningStyle}><strong>Could not save:</strong> {error}</div> : null}

          <div style={rowStyle}>
            <button type="button" style={buttonStyle} disabled={busy} onClick={closeEditor}>
              Cancel
            </button>
            <button type="button" style={primaryButtonStyle} disabled={busy} onClick={() => void save()}>
              {busy ? <LoadingState label="Saving access" /> : "Save access"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MembersTable({
  members,
  agents,
  label,
  emptyLabel,
  onEdit,
}: {
  members: MemberRecord[];
  agents: AgentRecord[];
  label: string;
  emptyLabel: string;
  onEdit: (memberId: string) => void;
}) {
  const columns: DataTableColumn<MemberTableRow>[] = [
    { key: "principal", header: "Principal", render: (_value, row) => row.principal },
    { key: "role", header: "Role", render: (_value, row) => row.role, width: "140px" },
    { key: "status", header: "Status", render: (_value, row) => row.status, width: "120px" },
    { key: "grants", header: "Grants", render: (_value, row) => row.grants },
    { key: "action", header: "", render: (_value, row) => row.action, width: "80px" },
  ];
  const rows: MemberTableRow[] = members.map((member) => {
    const profile = profileForPrincipal(member, agents);
    return {
      id: member.id,
      member,
      principal: (
        <div style={{ display: "grid", gap: "2px" }}>
          <strong>{profile.label}</strong>
          <span style={mutedTextStyle}>{profile.secondary}</span>
        </div>
      ),
      role: member.membershipRole ? formatMode(member.membershipRole) : "Unset",
      status: <StatusBadge label={formatMode(member.status)} status={membershipStatusVariant(member.status)} />,
      grants: `${member.grants.length} explicit grant${member.grants.length === 1 ? "" : "s"}`,
      action: <button type="button" style={buttonStyle} onClick={() => onEdit(member.id)}>Edit</button>,
    };
  });
  return (
    <div style={subtleCardStyle}>
      <div style={rowStyle}>
        <strong>{label}</strong>
        <StatusBadge label={`${members.length}`} status={members.length > 0 ? "info" : "pending"} />
      </div>
      <DataTable
        columns={columns as unknown as DataTableColumn<Record<string, unknown>>[]}
        rows={rows as unknown as Record<string, unknown>[]}
        emptyMessage={emptyLabel}
      />
    </div>
  );
}

function GrantRows({ grants }: { grants: AdvancedPolicyData["actorGrants"] }) {
  if (grants.length === 0) {
    return <div style={mutedTextStyle}>No assignment grants for this actor yet.</div>;
  }
  return (
    <div style={{ display: "grid", gap: "8px" }}>
      {grants.map((grant, index) => (
        <div key={`${grant.permissionKey}-${index}`} style={{ ...rowStyle, justifyContent: "space-between", borderTop: index === 0 ? undefined : "1px solid var(--border, #e2e8f0)", paddingTop: index === 0 ? 0 : "8px" }}>
          <StatusBadge label={formatPermission(grant.permissionKey)} status="info" />
          <span style={mutedTextStyle}>{formatScope(grant.scope)}</span>
        </div>
      ))}
    </div>
  );
}

function CurrentAgentPolicy({ policy }: { policy: AdvancedPolicyData["agentPolicy"] }) {
  if (!policy?.policy) {
    return <div style={mutedTextStyle}>No saved policy. Saving below will create one.</div>;
  }
  const visibilityMode = getPolicyString(policy.policy, "agentVisibility", "mode", "discoverable");
  const assignmentMode = getPolicyString(policy.policy, "assignmentPolicy", "mode", "company_default");
  const requiresApproval = getPolicyBoolean(policy.policy, "protectedAgent", "requiresApproval", false);
  const approvalReason = getPolicyString(policy.policy, "protectedAgent", "approvalReason", "");
  return (
    <KeyValueList
      pairs={[
        {
          label: "Visibility",
          value: (
            <span title="Controls whether this agent appears in assignment and discovery surfaces.">
              {formatMode(visibilityMode)}
            </span>
          ),
        },
        {
          label: "Assignment",
          value: (
            <span title="Controls whether assignment follows company defaults or protected-agent rules.">
              {formatMode(assignmentMode)}
            </span>
          ),
        },
        {
          label: "Protected agent",
          value: requiresApproval
            ? `Requires approval${approvalReason ? `: "${approvalReason}"` : ""}`
            : "No approval required",
        },
      ]}
    />
  );
}

function DecisionCard({ title, decision }: { title: string; decision: DecisionRecord | null }) {
  if (!decision) return null;
  return (
    <div style={cardStyle}>
      <div style={rowStyle}>
        <div style={sectionHeadingStyle}>{title}</div>
        <StatusBadge label={decisionLabel(decision.allowed)} status={statusForDecision(decision.allowed)} />
      </div>
      <div>{decision.explanation}</div>
      <KeyValueList
        pairs={[
          { label: "Reason", value: formatMode(decision.reason) },
          { label: "Action", value: formatPermission(decision.action) },
          {
            label: "Matching grant",
            value: decision.grant ? `${formatPermission(decision.grant.permissionKey)} / ${formatScope(decision.grant.scope)}` : "No matching grant",
          },
        ]}
      />
      <RawDisclosure data={decision} />
    </div>
  );
}

function AuthorizationAudit({
  entries,
  agents,
}: {
  entries: AuditEntry[];
  agents: AgentRecord[];
}) {
  type AuditRow = {
    id: string;
    time: string;
    actor: ReactNode;
    action: string;
    resource: string;
    decision: ReactNode;
    details: ReactNode;
  };
  const columns: DataTableColumn<AuditRow>[] = [
    { key: "time", header: "Time", render: (_value, row) => row.time, width: "170px" },
    { key: "actor", header: "Actor", render: (_value, row) => row.actor },
    { key: "action", header: "Action", render: (_value, row) => row.action },
    { key: "resource", header: "Resource", render: (_value, row) => row.resource },
    { key: "decision", header: "Decision", render: (_value, row) => row.decision, width: "120px" },
    { key: "details", header: "Details", render: (_value, row) => row.details },
  ];
  const rows: AuditRow[] = entries.map((entry) => {
    const agent = entry.actorType === "agent" ? agents.find((candidate) => candidate.id === entry.actorId) : null;
    const decision = entry.details?.decision === "deny" ? false : entry.details?.decision === "allow" ? true : null;
    return {
      id: entry.id,
      time: formatDate(entry.createdAt),
      actor: (
        <div style={{ display: "grid", gap: "2px" }}>
          <strong>{agent?.name ?? formatMode(entry.actorType)}</strong>
          <span style={mutedTextStyle}>{entry.actorId}</span>
        </div>
      ),
      action: formatPermission(entry.action),
      resource: `${entry.entityType} / ${entry.entityId}`,
      decision: decision === null
        ? <StatusBadge label="Unknown" status="pending" />
        : <StatusBadge label={decisionLabel(decision)} status={statusForDecision(decision)} />,
      details: <RawDisclosure label="Details" data={entry.details ?? {}} />,
    };
  });
  return (
    <DataTable
      columns={columns as unknown as DataTableColumn<Record<string, unknown>>[]}
      rows={rows as unknown as Record<string, unknown>[]}
      emptyMessage="No authorization decisions in this filter window yet. Adjust the filters above to broaden the audit search."
    />
  );
}

function AdvancedPolicyEditor({ companyId }: { companyId: string }) {
  const saveAgentPolicy = usePluginAction("saveAgentPolicy");
  const saveAssignmentGrant = usePluginAction("saveAssignmentGrant");
  const [actorAgentId, setActorAgentId] = useState("");
  const [targetAgentId, setTargetAgentId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [issueId, setIssueId] = useState("");
  const [auditAction, setAuditAction] = useState("");
  const [auditActorType, setAuditActorType] = useState("");
  const [auditEntityType, setAuditEntityType] = useState("");
  const [auditEntityId, setAuditEntityId] = useState("");
  const [auditDecision, setAuditDecision] = useState("");
  const [visibilityMode, setVisibilityMode] = useState("discoverable");
  const [assignmentMode, setAssignmentMode] = useState("company_default");
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [approvalReason, setApprovalReason] = useState("");
  const [grantMode, setGrantMode] = useState("scoped_agent");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<unknown>(null);
  const params = useMemo(() => ({
    companyId,
    actorAgentId,
    targetAgentId,
    projectId,
    issueId,
    auditAction,
    auditActorType,
    auditEntityType,
    auditEntityId,
    auditDecision,
  }), [companyId, actorAgentId, targetAgentId, projectId, issueId, auditAction, auditActorType, auditEntityType, auditEntityId, auditDecision]);
  const query = usePluginData<AdvancedPolicyData>("advancedPolicy", params);
  const data = query.data;

  useEffect(() => {
    if (!data) return;
    if (!actorAgentId && data.selected.actorAgentId) setActorAgentId(data.selected.actorAgentId);
    if (!targetAgentId && data.selected.targetAgentId) setTargetAgentId(data.selected.targetAgentId);
    if (!projectId && data.selected.projectId) setProjectId(data.selected.projectId);
    if (!issueId && data.selected.issueId) setIssueId(data.selected.issueId);
  }, [actorAgentId, data, issueId, projectId, targetAgentId]);

  useEffect(() => {
    const policy = data?.agentPolicy?.policy;
    setVisibilityMode(getPolicyString(policy, "agentVisibility", "mode", "discoverable"));
    setAssignmentMode(getPolicyString(policy, "assignmentPolicy", "mode", "company_default"));
    setRequiresApproval(getPolicyBoolean(policy, "protectedAgent", "requiresApproval", false));
    setApprovalReason(getPolicyString(policy, "protectedAgent", "approvalReason", ""));
  }, [data?.agentPolicy?.resourceId, data?.agentPolicy?.updatedAt]);

  const issueOptions = useMemo(
    () => (data?.issues ?? []).filter((issue) => !projectId || issue.projectId === projectId),
    [data?.issues, projectId],
  );

  async function run(label: string, action: () => Promise<unknown>) {
    setBusyAction(label);
    try {
      const result = await action();
      setLastResult(result);
      query.refresh();
    } catch (error) {
      setLastResult({ error: getErrorMessage(error) });
    } finally {
      setBusyAction(null);
    }
  }

  if (query.loading && !data) {
    return <LoadingState label="Loading advanced policy editors" />;
  }

  if (query.error) {
    return (
      <div style={warningStyle}>
        <strong>Advanced policy APIs unavailable.</strong>
        <div>{query.error.message}</div>
      </div>
    );
  }

  const hasPreviewSelection = Boolean(actorAgentId && targetAgentId);

  return (
    <div style={layoutStack}>
      <CapabilityWarning warnings={data?.warnings ?? []} />

      <div style={gridStyle}>
        <MetricCard label="Mode" value={formatMode(data?.summary?.permissionsMode ?? "unknown")} />
        <MetricCard label="Active members" value={`${data?.summary?.activeMemberCount ?? 0} / ${data?.summary?.memberCount ?? 0}`} />
        <MetricCard label="Explicit grants" value={data?.summary?.grantCount ?? 0} />
      </div>

      <div style={{ borderTop: "1px solid var(--border, #e2e8f0)", paddingTop: "16px", display: "grid", gap: "12px" }}>
        <div>
          <div style={sectionHeadingStyle}>Policy preview</div>
          <strong>Check assignment decisions before saving policy changes</strong>
        </div>
        <div style={gridStyle}>
          <label style={fieldStyle}>
            <span style={sectionHeadingStyle}>Actor agent</span>
            <AssigneePicker
              companyId={companyId}
              value={actorAgentId ? `agent:${actorAgentId}` : ""}
              includeUsers={false}
              placeholder="Select actor agent"
              noneLabel="No actor"
              onChange={(_value, selection) => setActorAgentId(selection.assigneeAgentId ?? "")}
            />
          </label>
          <label style={fieldStyle}>
            <span style={sectionHeadingStyle}>Target agent</span>
            <AssigneePicker
              companyId={companyId}
              value={targetAgentId ? `agent:${targetAgentId}` : ""}
              includeUsers={false}
              placeholder="Select target agent"
              noneLabel="No target"
              onChange={(_value, selection) => setTargetAgentId(selection.assigneeAgentId ?? "")}
            />
          </label>
          <label style={fieldStyle}>
            <span style={sectionHeadingStyle}>Project scope</span>
            <ProjectPicker
              companyId={companyId}
              value={projectId}
              placeholder="Any project"
              noneLabel="Any project"
              onChange={setProjectId}
            />
          </label>
          <label style={fieldStyle}>
            <span style={sectionHeadingStyle}>Issue context</span>
            <select style={inputStyle} value={issueId} onChange={(event) => setIssueId(event.target.value)}>
              <option value="">No issue</option>
              {issueOptions.map((issue) => <option key={issue.id} value={issue.id}>{issue.title}</option>)}
            </select>
          </label>
        </div>
        {!hasPreviewSelection ? (
          <div style={mutedTextStyle}>Select an actor and target agent to preview a policy decision.</div>
        ) : (
          <div style={gridStyle}>
            <DecisionCard title="Preview Decision" decision={data?.preview ?? null} />
            <DecisionCard title="Permission Explanation" decision={data?.explanation ?? null} />
          </div>
        )}
      </div>

      <div style={gridStyle}>
        <div style={cardStyle}>
          <div style={sectionHeadingStyle}>Agent Visibility</div>
          <label style={fieldStyle}>
            <span>Directory mode</span>
            <select style={inputStyle} value={visibilityMode} onChange={(event) => setVisibilityMode(event.target.value)}>
              <option value="discoverable">Discoverable</option>
              <option value="private">Private</option>
            </select>
          </label>
          <label style={fieldStyle}>
            <span>Assignment mode</span>
            <select style={inputStyle} value={assignmentMode} onChange={(event) => setAssignmentMode(event.target.value)}>
              <option value="company_default">Company default</option>
              <option value="protected">Protected</option>
            </select>
          </label>
          <label style={rowStyle}>
            <input type="checkbox" checked={requiresApproval} onChange={(event) => setRequiresApproval(event.target.checked)} />
            <span>Require approval for protected assignment</span>
          </label>
          <label style={fieldStyle}>
            <span>Approval reason</span>
            <input style={inputStyle} value={approvalReason} onChange={(event) => setApprovalReason(event.target.value)} />
          </label>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={!targetAgentId || busyAction !== null}
            onClick={() => void run("policy", () => saveAgentPolicy({
              companyId,
              agentId: targetAgentId,
              visibilityMode,
              assignmentMode,
              requiresApproval,
              approvalReason,
            }))}
          >
            {busyAction === "policy" ? <LoadingState label="Saving agent policy" /> : "Save agent policy"}
          </button>
        </div>

        <div style={cardStyle}>
          <div style={sectionHeadingStyle}>Assignment Policy</div>
          <label style={fieldStyle}>
            <span>Grant mode</span>
            <select style={inputStyle} value={grantMode} onChange={(event) => setGrantMode(event.target.value)}>
              <option value="scoped_agent">Scoped to selected target</option>
              <option value="broad">Broad assignment</option>
              <option value="clear">Clear assignment grants</option>
            </select>
          </label>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={!actorAgentId || busyAction !== null}
            onClick={() => void run("grants", () => saveAssignmentGrant({
              companyId,
              actorAgentId,
              targetAgentId,
              projectId,
              mode: grantMode,
            }))}
          >
            {busyAction === "grants" ? <LoadingState label="Saving assignment grants" /> : "Save assignment grants"}
          </button>
          <GrantRows grants={data?.actorGrants ?? []} />
        </div>
      </div>

      <div style={cardStyle}>
        <div style={sectionHeadingStyle}>Current Agent Policy</div>
        <CurrentAgentPolicy policy={data?.agentPolicy ?? null} />
      </div>

      <div style={cardStyle}>
        <div style={{ ...rowStyle, justifyContent: "space-between" }}>
          <div>
            <div style={sectionHeadingStyle}>Authorization Audit</div>
            <strong>Recent authorization decisions</strong>
          </div>
          <button type="button" style={buttonStyle} onClick={() => query.refresh()}>Refresh</button>
        </div>
        <div style={{ ...gridStyle, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
          <label style={fieldStyle}>
            <span>Action</span>
            <input style={inputStyle} value={auditAction} onChange={(event) => setAuditAction(event.target.value)} />
          </label>
          <label style={fieldStyle}>
            <span>Actor type</span>
            <select style={inputStyle} value={auditActorType} onChange={(event) => setAuditActorType(event.target.value)}>
              <option value="">Any actor</option>
              <option value="agent">Agent</option>
              <option value="user">User</option>
              <option value="plugin">Plugin</option>
              <option value="system">System</option>
            </select>
          </label>
          <label style={fieldStyle}>
            <span>Resource type</span>
            <input style={inputStyle} value={auditEntityType} onChange={(event) => setAuditEntityType(event.target.value)} />
          </label>
          <label style={fieldStyle}>
            <span>Resource id</span>
            <input style={inputStyle} value={auditEntityId} onChange={(event) => setAuditEntityId(event.target.value)} />
          </label>
          <label style={fieldStyle}>
            <span>Decision</span>
            <select style={inputStyle} value={auditDecision} onChange={(event) => setAuditDecision(event.target.value)}>
              <option value="">Any decision</option>
              <option value="allow">Allow</option>
              <option value="deny">Deny</option>
            </select>
          </label>
        </div>
        <AuthorizationAudit entries={data?.auditEntries ?? []} agents={data?.agents ?? []} />
      </div>

      {lastResult ? <RawDisclosure label="Last saved raw response" data={lastResult} /> : null}
    </div>
  );
}

function EePermissionsCompanySettingsPageContent(_props: PluginCompanySettingsPageProps) {
  const hostContext = useHostContext();
  const companyId = hostContext.companyId;
  const overview = usePluginData<Overview>("overview", companyId ? { companyId } : {});
  const activate = usePluginAction("activateLicense");
  const deactivate = usePluginAction("deactivateLicense");
  const [activationBusy, setActivationBusy] = useState(false);

  if (!companyId) return <MissingCompanyState />;

  if (overview.loading && !overview.data) {
    return (
      <div style={layoutStack}>
        <div style={cardStyle}>
          <LoadingState label="Loading permissions overview" />
        </div>
      </div>
    );
  }

  if (overview.error) {
    return (
      <div style={layoutStack}>
        <div style={cardStyle}>
          <div style={sectionHeadingStyle}>Permissions</div>
          <strong>Could not load permissions</strong>
          <div style={mutedTextStyle}>
            <code>{overview.error.code}</code>: {overview.error.message}
          </div>
        </div>
      </div>
    );
  }

  const data = overview.data;
  if (!data) {
    return (
      <div style={layoutStack}>
        <div style={cardStyle}>
          <div style={mutedTextStyle}>No permissions data returned yet.</div>
        </div>
      </div>
    );
  }

  if (data.license.status !== "active") {
    return (
      <UnlicensedState
        companyId={companyId}
        activating={activationBusy}
        onActivate={() => {
          setActivationBusy(true);
          void activate({ companyId })
            .then(() => overview.refresh())
            .finally(() => setActivationBusy(false));
        }}
      />
    );
  }

  return (
    <div style={layoutStack}>
      <div style={cardStyle}>
        <div style={rowStyle}>
          <strong>Advanced policy editing is active</strong>
          <StatusBadge label="Active" status="ok" />
          <details>
            <summary style={{ ...mutedTextStyle, cursor: "pointer" }}>About enforcement</summary>
            <div style={mutedTextStyle}>
              Policy data stays in core. If this plugin is unavailable later, existing restrictions remain server-enforced.
            </div>
          </details>
        </div>
        <div>
          <button
            type="button"
            style={buttonStyle}
            disabled={activationBusy}
            onClick={() => {
              setActivationBusy(true);
              void deactivate({ companyId })
                .then(() => overview.refresh())
                .finally(() => setActivationBusy(false));
            }}
          >
            {activationBusy ? <LoadingState label="Updating" /> : "Deactivate"}
          </button>
        </div>
      </div>

      <MembersPanel companyId={companyId} />
      <AdvancedPolicyEditor companyId={companyId} />
    </div>
  );
}

export function EePermissionsCompanySettingsPage(props: PluginCompanySettingsPageProps) {
  return (
    <ErrorBoundary fallback={<div style={warningStyle}>The Paperclip EE permissions UI could not render.</div>}>
      <EePermissionsCompanySettingsPageContent {...props} />
    </ErrorBoundary>
  );
}
