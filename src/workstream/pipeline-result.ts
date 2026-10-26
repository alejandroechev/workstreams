/** One colour per run result, shared by the Inbox and the Pipelines manager. */
export function resultColor(result: string): string {
  switch (result) {
    case "failed": return "#f38ba8";
    case "succeeded": return "#a6e3a1";
    case "partiallySucceeded": return "#f9e2af";
    default: return "#6c7086";
  }
}
