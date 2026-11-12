import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { canSeeTask, loadAccess, memberSpaceIds } from "./access";
import { all, bad, first, isDev, type Env, type HonoEnv, type User } from "./env";
import { searchWorkspace, visibleMeetingIds } from "./misc";
import type { TaskRow } from "./tasks";

// If Claude declines a request on safety grounds, the API retries it on a fallback model
// chosen by refusal category rather than failing the meeting or the answer outright.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export const hasClaude = (env: Env) => !!env.ANTHROPIC_API_KEY;
const client = (env: Env) => new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// ---------- Transcription ----------

/** Transcribes one audio segment with Whisper on Workers AI. */
export async function transcribe(env: Env, audio: ArrayBuffer, hint: string): Promise<string> {
  if (isDev(env)) return "(Development mode: this audio segment was stored but not transcribed.)";
  const res = (await env.AI.run(env.WHISPER_MODEL as any, {
    audio: Buffer.from(audio).toString("base64"),
    initial_prompt: hint.slice(0, 800),
    vad_filter: true,
  } as any)) as { text?: string };
  return (res.text ?? "").trim();
}

// ---------- Meeting summary ----------

export const MeetingExtraction = z.object({
  title: z.string().describe("A short, specific title for the meeting (no date)."),
  summary_markdown: z.string().describe("The summary in Markdown, following the format in the instructions."),
  action_items: z.array(
    z.object({
      title: z.string().describe("Short task name starting with a verb."),
      owner_email: z.string().nullable().describe("Email of the responsible person, exactly as listed in the directory or participants; null if nobody listed fits."),
      owner_name: z.string().nullable().describe("The owner's name as best understood from the conversation, even if they aren't listed."),
      owner_uncertain: z.boolean().describe("True when it isn't clear from the conversation who agreed to do this."),
      due_date: z.string().nullable().describe("YYYY-MM-DD, only if a date or deadline was actually stated; otherwise null."),
      context: z.string().describe("One or two sentences of context so the task makes sense on its own."),
      duplicate_of: z.string().nullable().describe("Id of an existing open task with the same meaning, if any; otherwise null."),
    }),
  ),
  knowledge: z.array(
    z.object({
      kind: z.enum(["decision", "fact", "process", "contact", "idea", "risk"]),
      title: z.string().describe("A short headline that would make sense months from now."),
      body: z.string().describe("One to four sentences stating the knowledge on its own terms, with names, figures and dates."),
    }),
  ),
});
export type MeetingExtraction = z.infer<typeof MeetingExtraction>;

const SUMMARY_SYSTEM = `You turn the transcript of a business meeting or call into a summary, a list of action items, and durable knowledge notes for the company's shared knowledge base.

The transcript comes from automatic speech recognition. It has no speaker labels and will contain mis-heard words, especially names of people, products and suppliers. Use the participant list, the directory and context to work out who is speaking and what was meant, and silently correct obvious recognition errors. When something material is genuinely unclear, say so in the summary rather than guessing.

Summary (summary_markdown)
Write for someone who wasn't in the room and needs to know what happened and what they must do. Lead with a two- or three-sentence overview of what the meeting was for and where it landed. Then use "## Key points" (grouped by topic, with the reasoning behind positions where it was given), "## Decisions" (what was agreed, including figures, dates and names) and, if any remain, "## Open questions". Omit a section when it would be empty. Be specific and concrete; prefer the actual number, name or date to a vague reference. Don't list the action items in the summary: they are returned separately. Plain Markdown only, no title heading.

Action items
One entry for each thing a person agreed, or was asked, to do after the meeting.
- Start the title with a verb and keep it short.
- Assign the owner by email only when they appear in the directory or participant list. If the person responsible is someone else (a supplier, contractor, adviser), leave owner_email null and put their name in owner_name. If it is unclear who took it on, set owner_uncertain to true.
- Set due_date only when a date or deadline was stated; resolve relative dates ("by Friday", "end of the month") against the meeting date. Never invent a deadline.
- Skip decisions and general notes that aren't actions, and anything already done during the meeting.
- If an existing open task (listed in the request) already covers the same thing, set duplicate_of to its id.

Knowledge
Notes worth keeping in the company's long-term memory: decisions and their rationale, facts and figures (prices, quantities, dates, terms), how a process works or will work, who a contact is and what they do, ideas worth revisiting, and risks. Each note must stand alone without the transcript. Leave out small talk, scheduling chatter and anything that will be irrelevant in a month. A short routine meeting may produce none.`;

export type SummaryInput = {
  title: string;
  spaceName: string | null;
  startedAt: number;
  transcript: string;
  participants: { name: string; email: string }[];
  directory: { name: string; email: string }[];
  openTasks: { id: string; title: string; assignee: string | null }[];
};

export async function summariseMeeting(env: Env, input: SummaryInput): Promise<MeetingExtraction> {
  if (!hasClaude(env)) {
    if (isDev(env)) return mockExtraction(input);
    throw new Error("The Anthropic API key isn't set, so the meeting can't be summarised yet.");
  }
  const date = new Date(input.startedAt).toISOString().slice(0, 10);
  const weekday = new Date(input.startedAt).toLocaleDateString("en-GB", { weekday: "long", timeZone: "Europe/London" });
  const user = [
    `Meeting: ${input.title || "(untitled)"}`,
    `Date: ${weekday} ${date}`,
    input.spaceName ? `Business / space: ${input.spaceName}` : "",
    "",
    "Participants:",
    ...(input.participants.length ? input.participants.map((p) => `- ${p.name}${p.email ? ` <${p.email}>` : ""}`) : ["- (not recorded)"]),
    "",
    "Workspace directory (people who can be assigned tasks):",
    ...input.directory.map((p) => `- ${p.name} <${p.email}>`),
    "",
    "Existing open tasks (for spotting duplicates):",
    ...(input.openTasks.length ? input.openTasks.map((t) => `- [${t.id}] ${t.title}${t.assignee ? ` (${t.assignee})` : ""}`) : ["- (none)"]),
    "",
    "<transcript>",
    input.transcript,
    "</transcript>",
  ].join("\n");

  const message = await client(env).beta.messages.parse({
    model: env.CLAUDE_MODEL,
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    system: SUMMARY_SYSTEM,
    output_config: { effort: "high", format: betaZodOutputFormat(MeetingExtraction) },
    messages: [{ role: "user", content: user }],
  });
  if (message.stop_reason === "refusal") throw new Error("Claude declined to summarise this recording.");
  if (message.stop_reason === "max_tokens") throw new Error("The summary was cut off because the meeting was too long to summarise in one pass.");
  if (!message.parsed_output) throw new Error("Claude returned a summary in an unexpected format.");
  return message.parsed_output;
}

function mockExtraction(input: SummaryInput): MeetingExtraction {
  const me = input.participants[0] ?? input.directory[0];
  const other = input.participants[1] ?? input.directory[1] ?? me;
  return {
    title: input.title || "Sample meeting",
    summary_markdown:
      "This is a **sample summary** produced in development mode, where no audio is sent for transcription. On the live app this is written by Claude from the real transcript.\n\n## Key points\n- The team walked through progress since the last meeting.\n- Supplier lead times were the main concern.\n\n## Decisions\n- Move the weekly review to Tuesday mornings.",
    action_items: [
      { title: "Confirm supplier lead times", owner_email: me?.email ?? null, owner_name: me?.name ?? null, owner_uncertain: false, due_date: null, context: "Raised as the main risk to the schedule.", duplicate_of: null },
      { title: "Circulate the revised schedule", owner_email: other?.email ?? null, owner_name: other?.name ?? null, owner_uncertain: false, due_date: new Date(input.startedAt + 3 * 86400_000).toISOString().slice(0, 10), context: "Agreed to send by the end of the week.", duplicate_of: null },
      { title: "Check who is covering the Saturday shift", owner_email: null, owner_name: null, owner_uncertain: true, due_date: null, context: "Nobody clearly took this on.", duplicate_of: null },
    ],
    knowledge: [
      { kind: "decision", title: "Weekly review moves to Tuesday mornings", body: "The weekly review will be held on Tuesday mornings from now on so that weekend figures are available." },
    ],
  };
}

// ---------- Ask AI ----------

const ASK_SYSTEM = (appName: string, user: User, today: string) => `You answer questions for ${user.name} from the contents of ${appName}, their company's shared workspace: pages and databases, meeting summaries and transcripts, tasks, and knowledge notes distilled from meetings. The workspace covers several businesses, each with its own space.

Use the tools to find what the workspace actually says before answering; don't answer from general knowledge when the question is about the company. Search with a few different phrasings when the first search comes up thin, and read the full item when a snippet looks relevant but incomplete. The tools only return what ${user.name} is allowed to see.

Answer directly and concisely, leading with the answer. Cite what you relied on with Markdown links using the url each tool result gives you, for example [Weekly bakery meeting](/meetings/abc123). If the workspace doesn't contain the answer, say so plainly and mention what you searched for; never fill gaps with invention. If sources disagree, say which is more recent.

Today is ${today}.`;

const SearchInput = z.object({ query: z.string().min(1) });
const ReadInput = z.object({ kind: z.enum(["page", "meeting", "task", "knowledge"]), id: z.string().min(1) });
const TasksInput = z.object({ assignee_email: z.string().nullish(), status: z.enum(["open", "done", "all"]).nullish(), space: z.string().nullish() });

const ASK_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_workspace",
    description: "Full-text search across pages, meetings (summaries and transcripts), tasks and knowledge notes. Returns up to 12 matches with a snippet, kind, id and url. Use short keyword queries rather than full sentences.",
    eager_input_streaming: true,
    input_schema: { type: "object", properties: { query: { type: "string", description: "Keywords to search for." } }, required: ["query"] },
  },
  {
    name: "read_item",
    description: "Read the full content of one item found by search: a page, a meeting (summary, participants and transcript), a task, or a knowledge note.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["page", "meeting", "task", "knowledge"] }, id: { type: "string" } },
      required: ["kind", "id"],
    },
  },
  {
    name: "list_tasks",
    description: "List tasks, optionally filtered by assignee email, status (open, done or all; default open) and space name. Use this for questions like 'what is X working on' or 'what's overdue'.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        assignee_email: { type: "string" },
        status: { type: "string", enum: ["open", "done", "all"] },
        space: { type: "string", description: "Space (business) name." },
      },
    },
  },
];

async function runTool(env: Env, user: User, name: string, input: unknown): Promise<{ content: string; is_error?: boolean; label: string }> {
  const invalid = (label: string) => ({ content: JSON.stringify({ INVALID_JSON: JSON.stringify(input) }), is_error: true, label });
  if (name === "search_workspace") {
    const p = SearchInput.safeParse(input);
    if (!p.success) return invalid("Searching");
    const hits = await searchWorkspace(env, user, p.data.query, 12);
    return {
      label: `Searched “${p.data.query}”`,
      content: hits.length
        ? JSON.stringify(hits.map((h) => ({ kind: h.kind, id: h.id, title: h.title, where: h.where, url: h.url, snippet: h.snippet.replace(/[\u0001\u0002]/g, "") })))
        : "No matches.",
    };
  }
  if (name === "read_item") {
    const p = ReadInput.safeParse(input);
    if (!p.success) return invalid("Reading");
    const { kind, id } = p.data;
    if (kind === "page") {
      const access = await loadAccess(env, user);
      const pg = await first<{ title: string; text: string; props: string | null; kind: string }>(env.DB, "SELECT title, text, props, kind FROM pages WHERE id = ? AND archived = 0", id);
      if (!pg || !access.level(id)) return { content: "Not found or not accessible.", is_error: true, label: "Reading a page" };
      let body = pg.text;
      if (pg.kind === "database") {
        const rows = await all<{ id: string; title: string; text: string }>(env.DB, "SELECT id, title, text FROM pages WHERE parent_id = ? AND kind = 'row' AND archived = 0 LIMIT 200", id);
        body += "\n\nRows:\n" + rows.map((r) => `- ${r.title} (/p/${r.id})${r.text ? `: ${r.text.slice(0, 300)}` : ""}`).join("\n");
      }
      return { label: `Read “${pg.title || "Untitled"}”`, content: JSON.stringify({ title: pg.title, url: `/p/${id}`, content: body.slice(0, 60_000) }) };
    }
    if (kind === "meeting") {
      const visible = await visibleMeetingIds(env, user, await memberSpaceIds(env, user));
      const m = await first<{ title: string; started_at: number; summary_html: string; transcript: string }>(env.DB, "SELECT title, started_at, summary_html, transcript FROM meetings WHERE id = ?", id);
      if (!m || !visible.has(id)) return { content: "Not found or not accessible.", is_error: true, label: "Reading a meeting" };
      const people = await all<{ name: string }>(env.DB, "SELECT name FROM meeting_participants WHERE meeting_id = ?", id);
      return {
        label: `Read meeting “${m.title || "Meeting"}”`,
        content: JSON.stringify({
          title: m.title, url: `/meetings/${id}`, date: new Date(m.started_at).toISOString().slice(0, 10),
          participants: people.map((p) => p.name),
          summary: m.summary_html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
          transcript: m.transcript.slice(0, 80_000),
        }),
      };
    }
    if (kind === "task") {
      const t = await first<TaskRow>(env.DB, "SELECT * FROM tasks WHERE id = ?", id);
      if (!t || !canSeeTask(t, user, await memberSpaceIds(env, user))) return { content: "Not found or not accessible.", is_error: true, label: "Reading a task" };
      return { label: `Read task “${t.title}”`, content: JSON.stringify({ ...t, url: `/tasks?open=${id}` }) };
    }
    const k = await first<{ title: string; body: string; kind: string; space_id: string | null; owner_id: string }>(env.DB, "SELECT * FROM knowledge WHERE id = ?", id);
    const spaces = await memberSpaceIds(env, user);
    if (!k || !(k.space_id ? spaces.has(k.space_id) : k.owner_id === user.id)) return { content: "Not found or not accessible.", is_error: true, label: "Reading a note" };
    return { label: `Read note “${k.title}”`, content: JSON.stringify({ title: k.title, kind: k.kind, body: k.body, url: `/brain?open=${id}` }) };
  }
  if (name === "list_tasks") {
    const p = TasksInput.safeParse(input ?? {});
    if (!p.success) return invalid("Listing tasks");
    const spaces = await memberSpaceIds(env, user);
    const rows = await all<TaskRow & { assignee_email: string | null; assignee_name: string | null; space_name: string | null }>(
      env.DB,
      `SELECT t.*, u.email AS assignee_email, u.name AS assignee_name, s.name AS space_name
         FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN spaces s ON s.id = t.space_id`,
    );
    const status = p.data.status ?? "open";
    const out = rows
      .filter((t) => canSeeTask(t, user, spaces))
      .filter((t) => (status === "all" ? true : status === "done" ? t.status === "done" : t.status !== "done"))
      .filter((t) => !p.data.assignee_email || t.assignee_email?.toLowerCase() === p.data.assignee_email.toLowerCase())
      .filter((t) => !p.data.space || (t.space_name ?? "").toLowerCase().includes(p.data.space.toLowerCase()))
      .slice(0, 150)
      .map((t) => ({ id: t.id, title: t.title, status: t.status, assignee: t.assignee_name, due: t.due, space: t.space_name, project: t.project || undefined, url: `/tasks?open=${t.id}` }));
    return { label: "Looked up tasks", content: out.length ? JSON.stringify(out) : "No matching tasks." };
  }
  return { content: `Unknown tool ${name}`, is_error: true, label: name };
}

export const ai = new Hono<HonoEnv>();

// Streams an answer as server-sent events: `text` deltas, `step` (a tool was used), `error`, `done`.
ai.post("/ask", async (c) => {
  const user = c.var.user;
  const body = await c.req.json<{ messages?: { role: "user" | "assistant"; content: string }[] }>();
  const history = (body.messages ?? []).filter((m) => m.content?.trim()).slice(-20);
  if (!history.length || history[history.length - 1].role !== "user") throw bad("Ask a question first.");
  const env = c.env;
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });

  return streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
    if (!hasClaude(env)) {
      // Development mode: answer from search alone so the interface can be exercised.
      const hits = isDev(env) ? await searchWorkspace(env, user, history[history.length - 1].content, 5) : [];
      const text = isDev(env)
        ? `*(Development mode: no AI key set, showing search matches.)*\n\n` + (hits.length ? hits.map((h) => `- [${h.title}](${h.url}) · ${h.where}`).join("\n") : "Nothing matched.")
        : "Ask AI isn't set up yet: the Anthropic API key hasn't been added.";
      await send("text", { delta: text });
      await send("done", {});
      return;
    }
    const messages: Anthropic.Beta.BetaMessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
    try {
      let jsonRetries = 0;
      for (let turn = 0; turn < 12; turn++) {
        const s = client(env).beta.messages.stream({
          model: env.CLAUDE_MODEL,
          max_tokens: 16000,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          system: ASK_SYSTEM(env.APP_NAME, user, today),
          tools: ASK_TOOLS as Anthropic.Beta.BetaToolUnion[],
          messages,
        });
        s.on("text", (delta) => void send("text", { delta }));
        let message: Anthropic.Beta.BetaMessage;
        try {
          message = await s.finalMessage();
          jsonRetries = 0;
        } catch (err) {
          // With eager input streaming a tool input can arrive unparseable; re-issue that turn.
          if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
          continue;
        }
        if (message.stop_reason === "refusal") {
          await send("text", { delta: "\n\nI can't help with that request." });
          break;
        }
        if (message.stop_reason === "max_tokens") {
          await send("text", { delta: "\n\n*(The answer was cut off for length.)*" });
          break;
        }
        const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (message.stop_reason === "pause_turn") {
          messages.push({ role: "assistant", content: message.content });
          continue;
        }
        if (!calls.length) break;
        messages.push({ role: "assistant", content: message.content });
        // Run the turn's tool calls together and return every result in one message.
        const results = await Promise.all(
          calls.map(async (call) => {
            const r = await runTool(env, user, call.name, call.input).catch((e) => ({ content: `Tool failed: ${String(e)}`, is_error: true, label: call.name }));
            await send("step", { label: r.label });
            return { type: "tool_result" as const, tool_use_id: call.id, content: r.content, is_error: r.is_error };
          }),
        );
        messages.push({ role: "user", content: results });
      }
    } catch (err) {
      const msg =
        err instanceof Anthropic.AuthenticationError ? "The Anthropic API key was rejected. Check the key in the Cloudflare settings."
        : err instanceof Anthropic.RateLimitError ? "Claude is rate-limited right now. Try again in a minute."
        : err instanceof Anthropic.APIError ? `Claude returned an error (${err.status ?? "network"}). Try again.`
        : "Something went wrong while answering.";
      console.error("ask failed", err);
      await send("error", { message: msg });
    }
    await send("done", {});
  });
});
