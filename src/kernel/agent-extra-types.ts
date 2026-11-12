/** rc.2-only host types kept out of kernel/types to avoid growing its already
 *  oversized export surface. Consumers import from here directly. */
export interface SubagentListEntry {
  kind?: 'child' | 'diagnostic'
  id: string
  label?: string
  name?: string
  path?: string
  depth?: number
  parentId?: string
  activity?: string
  mode?: string
  reason?: string
  hasChildren?: boolean
  createdAt?: number
}

export interface AgentTeamTaskView {
  id: string
  revision?: number
  subject: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted' | string
  ownerId?: string
  ownerName?: string
  blockedBy?: string[]
  writeScopes?: string[]
  ready?: boolean
  writeScopeWarnings?: string[]
}

export interface AgentTeamsService {
  isEnabled(agent: unknown): boolean
  setEnabled(agent: unknown, enabled: boolean, signal?: AbortSignal): Promise<void>
  listTasks(agent: unknown): AgentTeamTaskView[]
}
