import { resolve } from "node:path";
import { buildIndex, FeedVerificationError, loadFeed } from "./feed/index.ts";
import { type FeedIndex, feedIndex } from "./schema/index.ts";
import { loadRemoteFeed } from "./remote-feed.ts";

export interface FeedSource {
  feedDir?: string;
  feedUrl?: string;
  offline?: boolean;
  now: Date;
  onWarning?: (message: string) => void;
}

export const getFeed = async ({
  feedDir,
  feedUrl,
  offline,
  now,
  onWarning,
}: FeedSource): Promise<FeedIndex> => {
  if (feedDir) {
    const loaded = loadFeed(resolve(feedDir));
    if (loaded.problems.length > 0)
      throw new FeedVerificationError(`local feed is invalid (${loaded.problems.length} problems)`);
    return feedIndex.parse(JSON.parse(new TextDecoder().decode(buildIndex(loaded, now))));
  }
  const remote = await loadRemoteFeed({
    offline: offline === true,
    now,
    ...(feedUrl ? { url: feedUrl } : {}),
  });
  if (remote.warning) onWarning?.(remote.warning);
  return remote.feed;
};
