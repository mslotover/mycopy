/** Starting points offered alongside the templates a team saves itself. */
export const BUILTIN_TEMPLATES: { key: string; title: string; icon: string; blurb: string; html: string }[] = [
  {
    key: "meeting", title: "Meeting notes", icon: "🗒️", blurb: "Agenda, notes, decisions and actions",
    html: "<h2>Agenda</h2><ul><li><p></p></li></ul><h2>Notes</h2><p></p><h2>Decisions</h2><ul><li><p></p></li></ul><h2>Actions</h2><ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"false\"><p></p></li></ul>",
  },
  {
    key: "one-on-one", title: "1:1", icon: "👥", blurb: "A running record of a regular catch-up",
    html: "<h2>Since last time</h2><p></p><h2>Their topics</h2><ul><li><p></p></li></ul><h2>My topics</h2><ul><li><p></p></li></ul><h2>Agreed next steps</h2><ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"false\"><p></p></li></ul>",
  },
  {
    key: "project", title: "Project brief", icon: "🎯", blurb: "Why, what, who and when",
    html: "<div data-callout data-emoji=\"🎯\"><div><p>One sentence on what this project achieves and for whom.</p></div></div><h2>Why now</h2><p></p><h2>What success looks like</h2><ul><li><p></p></li></ul><h2>Scope</h2><p></p><h2>People</h2><p></p><h2>Timeline</h2><table><tbody><tr><th><p>Milestone</p></th><th><p>Owner</p></th><th><p>Date</p></th></tr><tr><td><p></p></td><td><p></p></td><td><p></p></td></tr></tbody></table><h2>Risks</h2><ul><li><p></p></li></ul>",
  },
  {
    key: "howto", title: "How we do it", icon: "🧭", blurb: "A step-by-step procedure anyone can follow",
    html: "<div data-callout data-emoji=\"🧭\"><div><p>When to use this, and who it is for.</p></div></div><h2>Before you start</h2><ul><li><p></p></li></ul><h2>Steps</h2><ol><li><p></p></li></ol><h2>If something goes wrong</h2><p></p><h2>Owner</h2><p></p>",
  },
  {
    key: "decision", title: "Decision record", icon: "⚖️", blurb: "What was decided, and why",
    html: "<h2>Decision</h2><p></p><h2>Context</h2><p></p><h2>Options considered</h2><ul><li><p></p></li></ul><h2>Why this one</h2><p></p><h2>What changes as a result</h2><ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"false\"><p></p></li></ul>",
  },
  {
    key: "weekly", title: "Weekly update", icon: "📣", blurb: "Progress, numbers and what is next",
    html: "<h2>Headlines</h2><ul><li><p></p></li></ul><h2>Numbers</h2><p></p><h2>What went well</h2><ul><li><p></p></li></ul><h2>What needs attention</h2><ul><li><p></p></li></ul><h2>Next week</h2><ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"false\"><p></p></li></ul>",
  },
];
