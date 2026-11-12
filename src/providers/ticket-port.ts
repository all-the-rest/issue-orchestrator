export interface TicketComment {
  id: string;
  body: string;
  /** Null when the GitHub account that authored the event was deleted. */
  author: string | null;
  createdAt: string;
  url?: string;
}

export interface TicketIssue {
  id: string;
  number: number;
  title: string;
  body: string;
  author: string | null;
  labels: string[];
  state: string;
  url: string;
  updatedAt: string | null;
  comments: TicketComment[];
}

export interface TicketUpdateBatch {
  updates: TicketComment[];
  nextCursor: string | null;
}

export interface TicketIdentity {
  number: number;
  author: string | null;
  state: string;
  url: string;
}

export interface TicketPort {
  select(project: string, limit?: number): Promise<TicketIssue[]>;
  /** Read issue identity/author only; never loads the title or body. */
  identity(project: string, number: number): Promise<TicketIdentity>;
  read(project: string, number: number): Promise<TicketIssue>;
  updates(project: string, number: number, cursor: string | null): Promise<TicketUpdateBatch>;
  /** Conversation and review comments on the ticket's change request, if it has one. */
  verifyChange?(project: string, number: number): Promise<{ number: number; state: string; url: string }>;
  changeUpdates?(project: string, number: number, cursor: string | null): Promise<TicketUpdateBatch>;
  publishStatus(project: string, number: number, key: string, body: string): Promise<{ id: string; skipped: boolean }>;
}
