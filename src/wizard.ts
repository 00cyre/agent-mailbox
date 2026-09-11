import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { AGENT_ID } from './types.js';

/**
 * The setup menu: which agents should this mailbox reach?
 *
 * A mailbox is only useful once it has peers, and the peers are not
 * discoverable — they are whichever assistants this person actually uses. So
 * the first run asks, instead of writing a config full of guesses that every
 * user then has to edit.
 *
 * The catalogue below is a starting point, not a whitelist: anything you type
 * becomes an agent, because the package cannot know what you will plug in next.
 */

export interface KnownAgent {
  id: string;
  description: string;
  /** Suggested as the relay — the agent that catches mail for unregistered chats. */
  relay?: boolean;
}

export const CATALOGUE: KnownAgent[] = [
  { id: 'claude', description: 'Claude Code / Claude Desktop chats', relay: true },
  { id: 'grokbot', description: 'Grok, or a Grok Bot agent' },
  { id: 'codex', description: 'OpenAI Codex CLI or desktop' },
  { id: 'chatgpt', description: 'ChatGPT conversations' },
  { id: 'cursor', description: 'Cursor agents, cloud or CLI' },
];

export interface Choice {
  ids: string[];
  relay: string;
  port: number;
}

function parseSelection(answer: string, catalogue: KnownAgent[]): string[] {
  const trimmed = answer.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'a' || trimmed.toLowerCase() === 'all') {
    return catalogue.map((a) => a.id);
  }

  const picked: string[] = [];
  for (const part of trimmed.split(/[,\s]+/u)) {
    if (!part) continue;
    const n = Number(part);
    if (Number.isInteger(n) && n >= 1 && n <= catalogue.length) {
      picked.push(catalogue[n - 1]!.id);
      continue;
    }
    // Not a number: a name. Lets someone add an agent the catalogue never heard of.
    const id = part.toLowerCase();
    if (!AGENT_ID.test(id)) throw new Error(`"${part}" is not a number on the list or a valid agent id`);
    picked.push(id);
  }
  return [...new Set(picked)];
}

/**
 * Ask. Falls back to defaults when there is no terminal, so `npx agent-mailbox
 * init` inside a script or a Dockerfile completes instead of hanging on a
 * prompt nobody will ever see.
 */
export async function chooseAgents(options: {
  defaultPort: number;
  preset?: string[];
}): Promise<Choice> {
  const fallback: Choice = {
    ids: options.preset && options.preset.length > 0 ? options.preset : CATALOGUE.map((a) => a.id),
    relay: 'claude',
    port: options.defaultPort,
  };

  if (!stdin.isTTY || (options.preset && options.preset.length > 0)) {
    return { ...fallback, relay: fallback.ids.includes('claude') ? 'claude' : fallback.ids[0]! };
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write('\nWhich agents should this mailbox reach?\n\n');
    CATALOGUE.forEach((agent, i) => {
      stdout.write(`  ${i + 1}. ${agent.id.padEnd(10)} ${agent.description}\n`);
    });
    stdout.write('\nNumbers, or names of your own, comma separated. Enter for all.\n');

    let ids: string[] = [];
    while (ids.length === 0) {
      try {
        ids = parseSelection(await rl.question('> '), CATALOGUE);
        if (ids.length === 0) stdout.write('Pick at least one.\n');
      } catch (error) {
        stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
      }
    }

    // The relay is the one that catches mail for chats nobody registered —
    // which is most of them, so it matters more than it looks.
    const relayDefault = ids.includes('claude') ? 'claude' : ids[0]!;
    stdout.write(
      `\nWhich one relays mail addressed to a chat that has not announced itself?\n` +
        `It receives the message and decides where it belongs. [${relayDefault}]\n`
    );
    const relayAnswer = (await rl.question('> ')).trim().toLowerCase();
    const relay = relayAnswer === '' ? relayDefault : relayAnswer;
    if (!ids.includes(relay)) throw new Error(`"${relay}" is not one of the agents you picked`);

    const portAnswer = (await rl.question(`\nPort? [${options.defaultPort}]\n> `)).trim();
    const port = portAnswer === '' ? options.defaultPort : Number(portAnswer);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`"${portAnswer}" is not a port`);
    }

    return { ids, relay, port };
  } finally {
    rl.close();
  }
}

export { parseSelection };
