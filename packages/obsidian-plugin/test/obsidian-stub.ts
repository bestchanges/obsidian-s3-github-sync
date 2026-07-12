// Test stub for the `obsidian` runtime module (the real package ships types only, no runtime).
// Aliased in vitest.config.ts. Notice records its messages so tests can assert the sync lifecycle.
export const noticeLog: string[] = [];

export class Notice {
  constructor(message: string) {
    noticeLog.push(message);
  }
}
