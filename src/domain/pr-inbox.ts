export interface PrInboxItem {
  id: string;
  project_id: string;
  repo_name: string;
  pr_id: number;
  title: string;
  author: string;
  url: string;
  is_read: boolean;
  discovered_at: string;
}

export interface PrInboxRepo {
  project_id: string;
  repo_name: string;
  enabled: boolean;
  last_checked: string | null;
  error: string | null;
}

export interface PrInboxSnapshot {
  items: PrInboxItem[];
  repos: PrInboxRepo[];
}

/** UI eligibility only; native code independently validates every HTTP destination. */
export function supportsPrInbox(remote: string | null): boolean {
  if (!remote) return false;
  try {
    const ssh = remote.trim().match(/^(?:git@ssh\.dev\.azure\.com:v3\/|ssh:\/\/git@ssh\.dev\.azure\.com\/v3\/)(.*)$/);
    let parts: string[];
    if (ssh) {
      parts = ssh[1].split("/");
    } else {
      const url = new URL(remote.trim());
      if (url.protocol !== "https:" || url.port || url.search || url.hash) return false;
      const path = url.pathname.replace(/\/$/, "").slice(1).split("/");
      if (url.hostname === "dev.azure.com" && path.length === 4 && path[2] === "_git") {
        parts = [path[0], path[1], path[3]];
      } else if (/^[^.]+\.visualstudio\.com$/.test(url.hostname) && path.length === 3 && path[1] === "_git") {
        parts = [url.hostname.split(".")[0], path[0], path[2]];
      } else return false;
    }
    return parts.length === 3 && parts.every((part) => {
      const decoded = decodeURIComponent(part);
      return decoded.length > 0 && decoded !== "." && decoded !== ".."
        && !decoded.includes("/") && !decoded.includes("\\")
        && !Array.from(decoded).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
    });
  } catch (error) {
    if (error instanceof TypeError || error instanceof URIError) return false;
    throw error;
  }
}
