// How the Agent team presents to people. Every runtime definition declares a presence, so a
// new Agent either joins the team (and appears in the classroom) or states why it stays internal.

export type AgentPresence =
  | { kind: 'staff'; name: string; mission: string }
  | { kind: 'internal'; reason: string };

/** One team member: a single figure however many runtime instances the Agent runs. */
export type RosterMember = { agentId: string; name: string; mission: string };
