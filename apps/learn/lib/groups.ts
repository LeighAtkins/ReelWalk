import type { Group } from "./types";

/** Each topic group is drawn as a railway line with its own colour and letter. */
export const GROUPS: Record<Group, { letter: string; color: string; en: string; ja: string }> = {
  app: { letter: "A", color: "#0079C2", en: "App", ja: "アプリ" },
  data: { letter: "D", color: "#8F5BB5", en: "Data", ja: "データ" },
  async: { letter: "Q", color: "#E2407F", en: "Queue & render", ja: "キューと制作{せいさく}" },
  platform: { letter: "P", color: "#00A3D9", en: "Platform", ja: "実行環境{じっこうかんきょう}" },
  delivery: { letter: "C", color: "#00994C", en: "CI/CD", ja: "リリース" },
  quality: { letter: "T", color: "#EE8A00", en: "Testing & security", ja: "テストと安全" },
  aws: { letter: "W", color: "#9A7B2F", en: "AWS design", ja: "AWS設計{せっけい}" },
};

export const GROUP_ORDER: Group[] = ["app", "data", "async", "platform", "delivery", "quality", "aws"];

export const STATUS_LABEL = {
  built: { en: "Built and running", ja: "実装済{じっそうず}み" },
  local: { en: "Runs locally with a stand-in", ja: "ローカルで検証{けんしょう}" },
  designed: { en: "Designed, not deployed", ja: "設計{せっけい}のみ" },
} as const;
