export interface TicketComment {
  id: string;
  body: string;
  author: string;
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

export interface TicketPort {
  select(project: string, limit?: number): Promise<TicketIssue[]>;
  read(project: string, number: number): Promise<TicketIssue>;
  updates(project: string, number: number, cursor: string | null): Promise<TicketUpdateBatch>;
  publishStatus(project: string, number: number, key: string, body: string): Promise<{ id: string; skipped: boolean }>;
}
