export function buildUnfurlApiParams(unfurl: boolean | undefined): {
  unfurl_links?: false;
  unfurl_media?: false;
} {
  return unfurl === false ? { unfurl_links: false, unfurl_media: false } : {};
}
