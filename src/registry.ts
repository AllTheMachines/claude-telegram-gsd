/**
 * Registry parser for ControlCenter project registry.
 *
 * Reads registry.md and extracts project entries from the markdown table.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

export interface Project {
  name: string;
  type: string;
  status: string;
  location: string;
  description: string;
}

const REGISTRY_PATH = resolve("D:/Projects/_ControlCenter/registry.md");

/**
 * Parse registry.md markdown table into Project objects.
 * Returns projects sorted: Active first, then alphabetically by name.
 */
export function parseRegistry(): Project[] {
  let content: string;
  try {
    content = readFileSync(REGISTRY_PATH, "utf-8");
  } catch (error) {
    console.error(`Failed to read registry: ${error}`);
    return [];
  }

  const projects: Project[] = [];

  // Find the markdown table rows (skip header and separator lines)
  const lines = content.split(/\r?\n/);
  let inTable = false;
  let headerSkipped = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect table start by looking for the header separator (|---|---|...)
    if (trimmed.match(/^\|[\s-]+\|/)) {
      inTable = true;
      headerSkipped = true;
      continue;
    }

    // Skip the header row (comes before separator)
    if (!headerSkipped && trimmed.startsWith("| Name")) {
      continue;
    }

    // Parse table rows
    if (inTable && trimmed.startsWith("|")) {
      const cells = trimmed
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);

      if (cells.length >= 5) {
        projects.push({
          name: cells[0]!,
          type: cells[1]!,
          status: cells[2]!,
          location: cells[3]!.replace(/\\/g, "/"),
          description: cells[4]!,
        });
      }
    }

    // End of table (empty line after table rows)
    if (inTable && !trimmed.startsWith("|") && trimmed === "") {
      break;
    }
  }

  // Sort: Active first, then alphabetically by name
  projects.sort((a, b) => {
    const aActive = a.status === "Active" ? 0 : 1;
    const bActive = b.status === "Active" ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return a.name.localeCompare(b.name);
  });

  return projects;
}
