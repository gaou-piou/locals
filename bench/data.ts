/** Shapes of the files the benchmark steps hand to each other. */
import { readFile } from "node:fs/promises";

export type CapturedSite = {
  site: string;
  ok: boolean;
  status: number;
  finalUrl: string;
  error?: string;
  requests: { url: string; type: string }[];
};

export const readJsonl = async <T>(file: string): Promise<T[]> =>
  (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
