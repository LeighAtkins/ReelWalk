import { appTopics } from "@/content/topics-app";
import { asyncTopics } from "@/content/topics-async";
import { platformTopics } from "@/content/topics-platform";
import { videos } from "@/content/videos";
import { company, generalQA, phraseSets, scripts } from "@/content/interview";
import { GROUP_ORDER, GROUPS } from "./groups";
import type { QA, Term, Topic, Video } from "./types";

export { company, generalQA, phraseSets, scripts, videos };

export const topics: Topic[] = [...appTopics, ...asyncTopics, ...platformTopics].sort(
  (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group),
);

export function topicById(id: string): Topic | undefined {
  return topics.find((t) => t.id === id);
}

/** Station code such as "Q3": the group's letter and the topic's place on that line. */
export function topicCode(topic: Topic): { letter: string; num: number; color: string } {
  const sameLine = topics.filter((t) => t.group === topic.group);
  const g = GROUPS[topic.group];
  return { letter: g.letter, num: sameLine.indexOf(topic) + 1, color: g.color };
}

export function videosFor(topicId: string): Video[] {
  return videos.filter((v) => v.topics.includes(topicId));
}

export interface DeckCard extends Term {
  key: string;
  topic: string;
}

/** Every term from every topic, deduplicated by its Japanese text. */
export const deck: DeckCard[] = (() => {
  const seen = new Set<string>();
  const cards: DeckCard[] = [];
  for (const t of topics) {
    for (const term of t.terms) {
      if (seen.has(term.ja)) continue;
      seen.add(term.ja);
      cards.push({ ...term, key: term.ja, topic: t.id });
    }
  }
  return cards;
})();

export interface DrillItem extends QA {
  key: string;
  source: string;
}

export const drill: DrillItem[] = [
  ...generalQA.map((qa, i) => ({ ...qa, key: `general-${i}`, source: "general" })),
  ...topics.flatMap((t) => t.qa.map((qa, i) => ({ ...qa, key: `${t.id}-${i}`, source: t.id }))),
];
