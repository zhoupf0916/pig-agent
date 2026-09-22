import { useState } from "react";
import {
  browserDraftStorage,
  loadComposerDraft,
  persistComposerDraft,
} from "../lib/composer-draft";
/** Account + project + conversation scope prevents one participant seeing another draft. */
export function useCloudDraft(
  scope: string,
): [string, (value: string) => void] {
  const key = "cloud:" + scope;
  const [draft, setDraft] = useState(() => ({
    key,
    value: loadComposerDraft(key, browserDraftStorage()),
  }));
  const value =
    draft.key === key
      ? draft.value
      : loadComposerDraft(key, browserDraftStorage());
  return [
    value,
    (value: string) => {
      persistComposerDraft(key, value, browserDraftStorage());
      setDraft({ key, value });
    },
  ];
}
