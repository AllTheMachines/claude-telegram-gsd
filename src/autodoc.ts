/**
 * Auto-documentation pipeline for Claude Code responses.
 *
 * Takes a raw Claude Code response + original user query, classifies the content,
 * creates a formatted Obsidian document with YAML frontmatter, updates the
 * category index file, and sends an email notification via Himalaya CLI.
 *
 * Usage:
 *   const result = await autoDocument(query, response);
 *   if (result) {
 *     // result.title, result.category, result.vaultPath, result.tags, result.emailSent, result.summary
 *   }
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

// ============== Constants ==============

const VAULT_ROOT = 'D:/Obsidian/Ideas';

const HIMALAYA_PATH = 'C:/Users/User/.local/bin/himalaya.exe';
const EMAIL_FROM = 'theaterofdelays@gmail.com';
const EMAIL_TO = 'ideas@randomstyles.net';

// ============== Types ==============

export interface AutoDocResult {
  title: string;        // Claude-generated descriptive title
  category: string;     // Human-readable category label
  vaultPath: string;    // Relative path from vault root (e.g. "ATM/2026-02-21_synth-routing.md")
  tags: string[];       // Keywords extracted from content
  emailSent: boolean;   // Whether email was successfully sent
  summary: string;      // 4-6 sentence summary of the document content
}

interface CategoryEntry {
  folder: string;
  index: string | null;
  label: string;
}

// ============== Category Map ==============

const CATEGORY_MAP: Record<string, CategoryEntry> = {
  atm:            { folder: 'ATM/',              index: 'ATM/ATM IDEAS.md',       label: 'ATM (Music Production)' },
  tofd:           { folder: 'TOFD/',             index: null,                      label: 'TOFD (Ambient Music)' },
  ideas:          { folder: 'IDEAS/ideas/',      index: 'IDEAS/_IDEAS.md',         label: 'Ideas' },
  biz:            { folder: 'Biz/',              index: 'Biz/BIZ IDEAS.md',        label: 'Business' },
  social:         { folder: 'SOCIAL MEDIA/',     index: null,                      label: 'Social Media' },
  writing:        { folder: 'Writing/',          index: 'Writing/_index.md',       label: 'Writing' },
  knowledge_base: { folder: 'Knowledge Base/',   index: null,                      label: 'Knowledge Base' },
  inbox:          { folder: 'Inbox/',            index: null,                      label: 'Inbox' },
};

// ============== Keyword Scoring ==============

// Each category has weighted keyword arrays. Higher weight = stronger signal.
// Format: [keyword, weight]
const CATEGORY_KEYWORDS: Record<string, Array<[string, number]>> = {
  atm: [
    ['vst', 3], ['plugin', 2], ['synth', 3], ['synthesizer', 3], ['audio', 2],
    ['music production', 3], ['daw', 3], ['bitwig', 3], ['ableton', 3], ['logic pro', 3],
    ['all the machines', 4], ['skiiid', 4], ['atm', 3], ['faceplate', 3],
    ['midi', 2], ['oscillator', 3], ['filter', 2], ['envelope', 2], ['lfo', 3],
    ['sample', 2], ['sampler', 2], ['drum machine', 3], ['beat', 2], ['bpm', 2],
    ['mixing', 2], ['mastering', 2], ['reverb', 2], ['delay', 2], ['compressor', 2],
    ['sound design', 3], ['preset', 2], ['patch', 2], ['modular', 3], ['eurorack', 3],
    ['reaktor', 3], ['max msp', 3], ['supercollider', 3], ['electron', 2],
    ['ios app', 2], ['ipad', 2], ['audiounit', 3], ['au plugin', 3],
  ],
  tofd: [
    ['theatre of delays', 5], ['tofd', 5], ['ambient', 3], ['drone', 2],
    ['atmospheric', 2], ['generative', 2], ['experimental', 2], ['modular ambient', 3],
    ['field recording', 3], ['soundscape', 3], ['texture', 2], ['minimal', 2],
    ['spenzer', 4], ['spenza', 4], ['vox sola', 4], ['raw stevens', 4],
  ],
  biz: [
    ['business', 3], ['revenue', 3], ['pricing', 3], ['saas', 3], ['subscription', 3],
    ['marketing', 3], ['sales', 2], ['customer', 2], ['monetize', 3], ['profit', 2],
    ['label', 2], ['record label', 3], ['distribution', 3], ['licensing', 3],
    ['vakant', 4], ['kwik snax', 4], ['startup', 2], ['product launch', 3],
    ['pitch', 2], ['investor', 3], ['funding', 3], ['budget', 2], ['cost', 2],
    ['strategy', 2], ['market', 2], ['competitor', 2], ['analytics', 2],
  ],
  social: [
    ['tiktok', 4], ['instagram', 4], ['twitter', 3], ['youtube', 3], ['social media', 4],
    ['content strategy', 3], ['posting', 2], ['engagement', 2], ['followers', 3],
    ['algorithm', 2], ['viral', 2], ['hashtag', 3], ['reel', 3], ['short video', 3],
    ['creator', 2], ['influencer', 2], ['brand', 2], ['audience', 2],
  ],
  writing: [
    ['article', 3], ['blog post', 3], ['essay', 3], ['script', 3], ['copywriting', 3],
    ['newsletter', 3], ['press release', 3], ['bio', 2], ['lyrics', 3],
    ['write', 2], ['writing', 3], ['draft', 2], ['edit', 2], ['proofread', 2],
    ['headline', 2], ['call to action', 2], ['story', 2], ['narrative', 2],
    ['video script', 3], ['transcript', 2], ['caption', 2], ['description', 2],
  ],
  knowledge_base: [
    ['programming', 3], ['code', 2], ['typescript', 3], ['javascript', 3], ['python', 3],
    ['algorithm', 2], ['pattern', 2], ['architecture', 3], ['design pattern', 3],
    ['debugging', 3], ['troubleshoot', 3], ['error', 2], ['bug', 2], ['fix', 2],
    ['api', 2], ['database', 3], ['sql', 3], ['node.js', 3], ['bun', 3],
    ['how to', 2], ['tutorial', 2], ['guide', 2], ['workflow', 2], ['process', 2],
    ['configuration', 2], ['setup', 2], ['install', 2], ['deploy', 3],
    ['git', 2], ['github', 2], ['cli', 2], ['terminal', 2], ['bash', 2],
    ['docker', 3], ['container', 3], ['server', 2], ['cloud', 2], ['devops', 3],
    ['react', 3], ['vue', 3], ['svelte', 3], ['css', 2], ['html', 2],
    ['technical', 2], ['implementation', 2], ['refactor', 2], ['optimize', 2],
  ],
  ideas: [
    ['idea', 3], ['concept', 2], ['brainstorm', 3], ['creative', 2], ['innovation', 2],
    ['project idea', 3], ['what if', 3], ['imagine', 2], ['explore', 2],
    ['general', 2], ['random', 2], ['thought', 2], ['inspiration', 2],
  ],
};

// ============== Utility Functions ==============

function slugify(text: string, maxLen = 60): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, maxLen)
    .replace(/-$/, '');
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ============== Classification ==============

function classifyContent(query: string, response: string): string {
  const combinedText = (query + ' ' + response).toLowerCase();
  const scores: Record<string, number> = {};

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const [keyword, weight] of keywords) {
      // Use word boundaries so "filter" doesn't match "filtered" in unrelated contexts
      // Multi-word phrases already act as natural boundaries
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
      const matches = combinedText.match(regex);
      if (matches) {
        score += matches.length * weight;
      }
    }
    scores[category] = score;
  }

  // Find the highest-scoring category
  let bestCategory = 'inbox';
  let bestScore = 0;
  const MINIMUM_THRESHOLD = 6; // At least this score to classify confidently

  for (const [category, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  if (bestScore < MINIMUM_THRESHOLD) {
    return 'inbox';
  }

  return bestCategory;
}

// ============== Title Generation ==============

function generateTitle(query: string, response: string): string {
  // Look for an existing H1 in the response
  const h1Match = response.match(/^#\s+(.+)$/m);
  if (h1Match?.[1]) {
    const h1 = h1Match[1].trim();
    return h1.length > 80 ? h1.slice(0, 77) + '...' : h1;
  }

  // Look for first meaningful sentence/line in response
  const firstLine = response.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 10 && !l.startsWith('#') && !l.startsWith('-') && !l.startsWith('*'))
    .find(l => l.length > 0);

  if (firstLine) {
    // Take first sentence
    const sentenceMatch = firstLine.match(/^(.{10,80}?)[.!?]/);
    if (sentenceMatch?.[1]) {
      return sentenceMatch[1].trim();
    }
    // Otherwise first ~10 words
    const words = firstLine.split(/\s+/).slice(0, 10).join(' ');
    return words.length > 80 ? words.slice(0, 77) + '...' : words;
  }

  // Fall back to a cleaned version of the query
  const cleanQuery = query.trim();
  const capitalized = cleanQuery.charAt(0).toUpperCase() + cleanQuery.slice(1);
  return capitalized.length > 80 ? capitalized.slice(0, 77) + '...' : capitalized;
}

// ============== Tag Extraction ==============

function extractTags(query: string, response: string, category: string): string[] {
  const combinedText = (query + ' ' + response).toLowerCase();
  const tagCandidates: Map<string, number> = new Map();

  // Score all keywords from CATEGORY_KEYWORDS and collect high-scoring ones
  for (const [, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const [keyword, weight] of keywords) {
      if (keyword.split(' ').length <= 2) { // Only single or double word tags
        const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        const matches = combinedText.match(regex);
        if (matches && matches.length > 0) {
          tagCandidates.set(keyword, (tagCandidates.get(keyword) ?? 0) + matches.length * weight);
        }
      }
    }
  }

  // Add the category itself as a tag
  const catEntry = CATEGORY_MAP[category];
  if (catEntry) {
    tagCandidates.set(category, 100); // Ensure it appears
  }

  // Sort by score, take top 5-7
  const sorted = Array.from(tagCandidates.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 7)
    .map(([tag]) => tag.replace(/\s+/g, '-'));

  // Ensure at least 3 tags — add category words if needed
  if (sorted.length < 3) {
    sorted.push('auto-documented', 'telegram-assistant');
  }

  return sorted.slice(0, 7);
}

// ============== Summary Generation ==============

function generateSummary(title: string, response: string): string {
  // Extract key content from the response for a 4-6 sentence summary
  const lines = response.split('\n').map(l => l.trim()).filter(l => l.length > 20);
  const sentences: string[] = [];

  for (const line of lines) {
    // Skip headings, bullets at the start
    const cleaned = line.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '').trim();
    if (cleaned.length > 20) {
      // Split into sentences
      const parts = cleaned.split(/(?<=[.!?])\s+/);
      for (const part of parts) {
        if (part.length > 15 && sentences.length < 6) {
          sentences.push(part);
        }
      }
    }
    if (sentences.length >= 6) break;
  }

  if (sentences.length === 0) {
    return `Document "${title}" has been automatically created from a Telegram Claude Code session.`;
  }

  return sentences.slice(0, 6).join(' ');
}

// ============== Document Structuring ==============

function structureDocument(title: string, query: string, response: string): string {
  const lines = response.split('\n');
  const resultLines: string[] = [];
  let hasHeadings = false;

  // Check if response has headings
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      hasHeadings = true;
      break;
    }
  }

  if (hasHeadings) {
    // Preserve the structure, replacing any H1 with our title
    let h1Replaced = false;
    for (const line of lines) {
      if (!h1Replaced && /^#\s+/.test(line)) {
        resultLines.push(`# ${title}`);
        h1Replaced = true;
      } else {
        resultLines.push(line);
      }
    }
    if (!h1Replaced) {
      resultLines.unshift(`# ${title}`, '');
    }
  } else {
    // No structure — add H1 and paste the response
    resultLines.push(`# ${title}`, '', ...lines);
  }

  // Remove trailing empty lines
  while (resultLines.length > 0 && resultLines[resultLines.length - 1]?.trim() === '') {
    resultLines.pop();
  }

  // Extract key takeaways: take numbered/bulleted points or first sentences of paragraphs
  const takeaways: string[] = [];
  const nonEmptyLines = lines.filter(l => l.trim().length > 10);
  for (const line of nonEmptyLines) {
    const trimmed = line.trim();
    // Prefer existing bullet points
    if (/^[-*]\s+.{15,}/.test(trimmed) || /^\d+\.\s+.{15,}/.test(trimmed)) {
      const text = trimmed.replace(/^[-*\d.]\s*/, '').trim();
      if (text.length > 15) {
        takeaways.push(`- ${text}`);
      }
    }
    if (takeaways.length >= 5) break;
  }

  // If not enough bullets, take first sentences from paragraphs
  if (takeaways.length < 3) {
    for (const line of nonEmptyLines) {
      const trimmed = line.trim().replace(/^#{1,6}\s+/, '');
      if (trimmed.length > 20 && !trimmed.startsWith('-') && !trimmed.startsWith('*')) {
        const sentenceMatch = trimmed.match(/^(.{20,120}?)[.!?]/);
        if (sentenceMatch?.[1]) {
          takeaways.push(`- ${sentenceMatch[1].trim()}`);
        }
      }
      if (takeaways.length >= 5) break;
    }
  }

  // Add Key Takeaways section
  resultLines.push('', '## Key Takeaways', '');
  if (takeaways.length > 0) {
    resultLines.push(...takeaways.slice(0, 5));
  } else {
    resultLines.push('- See full response above for details.');
  }

  // Add Original Query section
  resultLines.push('', '## Original Query', '', `> ${query}`);

  return resultLines.join('\n');
}

// ============== Index File Update ==============

function updateIndexFile(indexRelPath: string, filename: string, title: string): void {
  const indexPath = join(VAULT_ROOT, indexRelPath);
  if (!existsSync(indexPath)) {
    return; // Index doesn't exist — skip silently
  }

  const linkName = filename.replace(/\.md$/, '');
  const shortDesc = title.length > 60 ? title.slice(0, 57) + '...' : title;
  const linkLine = `[[${linkName}]] -- ${shortDesc}`;

  const indexContent = readFileSync(indexPath, 'utf-8');

  // Find end of YAML frontmatter (--- ... ---)
  const fmMatch = indexContent.match(/^---\n[\s\S]*?\n---\n?/);
  if (fmMatch) {
    const afterFm = fmMatch[0];
    const rest = indexContent.slice(afterFm.length);
    writeFileSync(indexPath, afterFm + linkLine + '\n' + rest, 'utf-8');
  } else {
    // No frontmatter — prepend to top
    writeFileSync(indexPath, linkLine + '\n' + indexContent, 'utf-8');
  }
}

// ============== Email Sending ==============

function sendEmail(subject: string, body: string): boolean {
  try {
    // Find himalaya — try known path first, then PATH
    let himalayaCmd = HIMALAYA_PATH;
    if (!existsSync(himalayaCmd)) {
      try {
        const found = execSync('where himalaya', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        himalayaCmd = found.trim().split(/\r?\n/)[0]?.trim() ?? 'himalaya';
      } catch {
        himalayaCmd = 'himalaya';
      }
    }

    // Himalaya expects a raw RFC2822 message piped to stdin
    const rawMessage = `From: ${EMAIL_FROM}\r\nTo: ${EMAIL_TO}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;

    // Write raw message to temp file, pipe to himalaya
    const tmpPath = join(process.env['TEMP'] ?? 'C:/Windows/Temp', `autodoc-email-${Date.now()}.txt`);
    writeFileSync(tmpPath, rawMessage, 'utf-8');

    const safeTmpPath = tmpPath.replace(/\\/g, '/');
    execSync(
      `"${himalayaCmd}" message send < "${safeTmpPath}"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], shell: 'cmd.exe' }
    );

    // Clean up temp file
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best effort cleanup
    }

    return true;
  } catch (err) {
    console.error('[autodoc] Email send failed:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

// ============== Ensure Inbox Exists ==============

// Create Inbox/ at module load time if it doesn't exist
mkdirSync(join(VAULT_ROOT, 'Inbox'), { recursive: true });

// ============== Main Export ==============

/**
 * Transform a Claude Code response into a classified Obsidian vault document.
 *
 * @param query   - The original user query sent to Claude Code
 * @param response - The raw Claude Code response text
 * @returns AutoDocResult with document metadata, or null if response is trivial/error
 */
export async function autoDocument(query: string, response: string): Promise<AutoDocResult | null> {
  // -- Trivial response check --
  if (wordCount(response) < 50) {
    return null;
  }

  // Check for error messages
  const trimmedResp = response.trim();
  const errorPrefixes = [
    'something went wrong',
    'error:',
    'an error occurred',
    'i apologize, but i',
    'i\'m sorry, but i',
  ];
  const lowerResp = trimmedResp.toLowerCase();
  if (errorPrefixes.some(prefix => lowerResp.startsWith(prefix))) {
    return null;
  }

  // -- Classification --
  const categoryKey = classifyContent(query, response);
  const catEntry = CATEGORY_MAP[categoryKey];
  if (!catEntry) {
    console.error(`[autodoc] Unknown category key: ${categoryKey}`);
    return null;
  }

  // -- Title and file naming --
  const title = generateTitle(query, response);
  const slug = slugify(title);
  const dateStr = todayStr();
  const filename = `${dateStr}_${slug}.md`;

  // Detect project field
  const knownProjects: Array<[string, string]> = [
    ['tofd', 'TOFD'],
    ['theatre of delays', 'TOFD'],
    ['atm', 'ATM'],
    ['all the machines', 'ATM'],
    ['skiiid', 'SKIIID'],
    ['faceplate', 'Faceplate'],
    ['controlcenter', 'ControlCenter'],
    ['control center', 'ControlCenter'],
    ['openclaw', 'OpenClaw'],
    ['open claw', 'OpenClaw'],
  ];

  const lowerCombined = (query + ' ' + response).toLowerCase();
  let projectField: string | null = null;
  for (const [keyword, projectName] of knownProjects) {
    if (lowerCombined.includes(keyword)) {
      projectField = projectName;
      break;
    }
  }

  // -- Tag extraction --
  const tags = extractTags(query, response, categoryKey);

  // -- Document structure --
  const structuredBody = structureDocument(title, query, response);

  // -- YAML frontmatter --
  const tagsYaml = `[${tags.map(t => t).join(', ')}]`;
  const frontmatter = [
    '---',
    `date: ${dateStr}`,
    `query: "${query.replace(/"/g, '\\"')}"`,
    `category: ${catEntry.label}`,
    `source: telegram-assistant`,
    `tags: ${tagsYaml}`,
    projectField ? `project: ${projectField}` : null,
    '---',
  ].filter(line => line !== null).join('\n');

  const fullDocument = frontmatter + '\n' + structuredBody + '\n';

  // -- Write document --
  const docFolder = join(VAULT_ROOT, catEntry.folder);
  mkdirSync(docFolder, { recursive: true });

  const filePath = join(docFolder, filename);
  writeFileSync(filePath, fullDocument, 'utf-8');

  // -- Update index file --
  if (catEntry.index) {
    try {
      updateIndexFile(catEntry.index, filename, title);
    } catch (err) {
      console.error('[autodoc] Index update failed:', err instanceof Error ? err.message : String(err));
    }
  }

  // -- Send email --
  const emailSent = sendEmail(title, fullDocument);

  // -- Generate summary --
  const summary = generateSummary(title, response);

  // -- Relative vault path --
  const vaultPath = `${catEntry.folder}${filename}`;

  return {
    title,
    category: catEntry.label,
    vaultPath,
    tags,
    emailSent,
    summary,
  };
}
