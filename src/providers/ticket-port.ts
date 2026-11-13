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

export interface ActivationMentionRequest {
  project: string;
  number: number;
  login: string;
  trustedAuthors: string[];
  excludedAuthors: string[];
  updatedAt?: string | null;
}

/**
 * One bounded activation scan. `page` continues a descending comment-page
 * scan; null starts after the newest page. `newest` additionally inspects the
 * newest page, so a late comment is observed before historical pages finish.
 * `knownTop` is the newest page observed by the previous scan of the same
 * comment thread; it lets the provider continue the historical cursor while
 * the thread top is unchanged and only restart when comments added a page.
 */
export interface ActivationScanRequest extends ActivationMentionRequest {
  page?: number | null;
  newest?: boolean;
  maxPages?: number;
  knownTop?: number | null;
  /**
   * True when the caller's saved scan for the previous revision had completed.
   * The provider then only inspects pages at or above `knownTop`, because lower
   * pages cannot change when comments are appended.
   */
  resumeComplete?: boolean;
}

export interface ActivationScanResult {
  matched: boolean;
  /** True when every relevant comment page was inspected for this revision. */
  complete: boolean;
  /** Next descending page to scan; null when complete or no scan is pending. */
  nextPage: number | null;
  /** Issue `updatedAt` observed by this scan ('' when the provider reports null). */
  revision: string;
  /**
   * Newest comment page observed by this scan (null when the provider could
   * not count comments). Content-free; the durable caller stores it so a later
   * scan can tell whether comments added a page.
   */
  topPage: number | null;
}

export interface TicketPort {
  select(project: string, limit?: number): Promise<TicketIssue[]>;
  /** Bounded discovery of open issues that mention an activation login. */
  selectMentioned?(project: string, login: string, limit?: number): Promise<TicketIssue[]>;
  /** Read issue identity/author only; never loads the title or body. */
  identity(project: string, number: number): Promise<TicketIdentity>;
  /** Privately inspect issue/comment text and return only whether activation is allowed. */
  hasActivationMention?(args: ActivationMentionRequest): Promise<boolean>;
  /**
   * Bounded activation scan with durable page-progress support. Returns only
   * booleans, page numbers and the content revision, never issue text.
   */
  scanActivationMention?(args: ActivationScanRequest): Promise<ActivationScanResult>;
  read(project: string, number: number): Promise<TicketIssue>;
  updates(project: string, number: number, cursor: string | null): Promise<TicketUpdateBatch>;
  /** Conversation and review comments on the ticket's change request, if it has one. */
  verifyChange?(project: string, number: number): Promise<{ number: number; state: string; url: string }>;
  changeUpdates?(project: string, number: number, cursor: string | null): Promise<TicketUpdateBatch>;
  publishStatus(project: string, number: number, key: string, body: string): Promise<{ id: string; skipped: boolean }>;
}
