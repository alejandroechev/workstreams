const LATEST_RELEASE_API =
  "https://api.github.com/repos/alejandroechev/workstreams/releases/latest";

const RELEASES_URL =
  "https://github.com/alejandroechev/workstreams/releases/latest";

export function detectDownloadPlatform({
  platform = "",
  userAgent = "",
} = {}) {
  const value = `${platform} ${userAgent}`.toLowerCase();
  if (value.includes("mac")) return "mac";
  if (value.includes("win")) return "windows";
  return "other";
}

export function selectDownloadAsset(assets, platform) {
  if (!Array.isArray(assets)) return null;
  const patterns = {
    windows: /_x64-setup\.exe$/i,
    mac: /-arm64\.dmg$/i,
  };
  const pattern = patterns[platform];
  return pattern ? assets.find((asset) => pattern.test(asset.name)) ?? null : null;
}

export function releasePresentation(release, platform, locale) {
  const releaseUrl = release.html_url || RELEASES_URL;
  const asset = selectDownloadAsset(release.assets, platform);
  const labels = {
    windows: "Download for Windows",
    mac: "Download for macOS (Apple Silicon)",
  };
  const published = new Date(release.published_at);

  return {
    tag: release.tag_name,
    date: Number.isNaN(published.valueOf())
      ? ""
      : new Intl.DateTimeFormat(locale, {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        }).format(published),
    releaseUrl,
    downloadUrl: asset?.browser_download_url ?? releaseUrl,
    downloadLabel: asset ? labels[platform] : "View all downloads",
    assetName: asset?.name ?? null,
  };
}

function setText(selector, value) {
  if (!value) return;
  for (const element of document.querySelectorAll(selector)) {
    element.textContent = value;
  }
}

function setHref(selector, value) {
  for (const element of document.querySelectorAll(selector)) {
    element.href = value;
  }
}

export function applyReleasePresentation(presentation) {
  setText("[data-release-tag]", presentation.tag);
  setText("[data-release-date]", presentation.date);
  setHref("[data-release-link]", presentation.releaseUrl);

  for (const link of document.querySelectorAll("[data-download-primary]")) {
    link.href = presentation.downloadUrl;
    link.textContent = presentation.downloadLabel;
    if (presentation.assetName) link.setAttribute("download", "");
    else link.removeAttribute("download");
  }

  setText(
    "[data-download-detail]",
    presentation.assetName
      ? `Latest installer: ${presentation.assetName}`
      : "Windows and Apple Silicon macOS builds are available.",
  );
}

export async function hydrateLatestRelease() {
  const platform = detectDownloadPlatform({
    platform: navigator.userAgentData?.platform ?? navigator.platform,
    userAgent: navigator.userAgent,
  });
  const response = await fetch(LATEST_RELEASE_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub latest-release request failed (${response.status})`);
  }
  applyReleasePresentation(
    releasePresentation(await response.json(), platform, navigator.language),
  );
}

if (typeof document !== "undefined") {
  const hydrate = () => {
    hydrateLatestRelease().catch((error) => {
      console.warn(
        "Could not resolve the OS-specific Workstreams download; keeping the releases-page fallback.",
        error,
      );
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", hydrate, { once: true });
  } else {
    hydrate();
  }
}
