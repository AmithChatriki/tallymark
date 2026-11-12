# Tallymark

Free, full-length practice exams for the Claude Certified Architect certifications, as a static website.

- 2 mocks for **Claude Certified Architect – Foundations** (60 questions, 120 minutes each)
- 2 mocks for **Claude Certified Architect – Professional** (63 questions, 120 minutes each)
- Exam mode (timed, no feedback until submission) and Practice mode (check each answer, optional pausable timer)
- Results report with domain breakdown, focus areas, and an explanation for every option
- No accounts, no backend, no tracking. Progress and history are stored only in the visitor's browser (`localStorage`).

> **Disclaimer.** Unofficial practice resource. Not affiliated with or endorsed by Anthropic. Questions are original and are not taken from the real exam.

## Assumptions behind the mocks

The official exam guides state the question count, time limit, domain weightings and a scaled passing score of 720 on a 100–1,000 scale. They do not state the following, so these are assumptions:

| Item | Assumption | Where to change it |
|---|---|---|
| Raw pass mark | 72% correct | `passingScore` in `data/manifest.json` |
| Share of multiple-response items | 8 "Select TWO" items per mock | The question files |
| Multiple-response scoring | All-or-nothing | `isCorrect()` in `js/app.js` |

The real Foundations exam presents 4 of 6 scenario contexts. Each Foundations mock here covers all six, and every question is tagged with its scenario.

## Project structure

```
index.html
css/styles.css
js/app.js
data/manifest.json              exams shown on the home page, and the list of mocks: id, title, exam, duration, pass mark, domains, file path
data/foundations-mock-1.json
data/foundations-mock-2.json
data/professional-mock-1.json
data/professional-mock-2.json
favicon.svg
README.md
```

There is no build step and no dependency other than Google Fonts (IBM Plex Sans and IBM Plex Mono), which falls back to system fonts if blocked.

## Run it locally

Opening `index.html` directly from disk does **not** work, because browsers block `fetch()` on `file://` pages. Serve the folder over HTTP instead:

```
python -m http.server
```

Then open <http://localhost:8000>.

## Deploy

### GitHub Pages

1. Create a new repository on GitHub and push the contents of this folder to the `main` branch, with `index.html` at the repository root.
2. In the repository, open **Settings**, then **Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
4. Choose branch `main` and folder `/ (root)`, then **Save**.
5. Wait a minute or two. The site URL appears at the top of the Pages settings (`https://<user>.github.io/<repo>/`).

All paths in the site are relative, so it works from a sub-path without changes.

### Netlify (drag and drop)

1. Sign in at <https://app.netlify.com>.
2. Open **Sites** and find the drop area labelled "Drag and drop your site output folder here" (or go to <https://app.netlify.com/drop>).
3. Drag this whole folder onto it.
4. Netlify publishes the site and gives it a URL. Rename it under **Site configuration** if you want.

To update the site later, drag the folder onto the **Deploys** tab of the same site.

## Pages

| Address | Screen |
|---|---|
| `#/` | Exam chooser: Foundations or Professional, plus a Resume bar for any unfinished mock |
| `#/foundations`, `#/professional` | That exam's page: domain weightings, its mocks, and attempt history for that exam only |
| `#/exam`, `#/review` | The running attempt |
| `#/report/<id>` | A saved report. "Back" returns to that exam's page |

The chooser is built from the `exams` list in `data/manifest.json`. Each entry has a `code` (matched against each mock's `examCode`), a `slug` (used in the address), a `name` and a one-line `summary`. A mock whose `examCode` has no entry still gets a page, named after its `exam` field.

## Background effect

The chooser and the exam pages have faint contour lines drifting slowly in the background (`.bg-fx` in `index.html`, styled at the end of `css/styles.css`). They are hidden on the question, review and report screens, and stay still for visitors whose device is set to reduce motion. To change the strength, edit `--fx-a` and `--fx-b`; to change the speed, edit the `140s` and `220s` animation durations. To remove the effect, delete the `.bg-fx` element.

## Question schema

Every mock file has this shape:

```json
{
  "mockId": "foundations-mock-1",
  "title": "Foundations Mock 1",
  "questions": [ ... ]
}
```

Every question uses the same fields:

| Field | Type | Notes |
|---|---|---|
| `id` | string | Permanent, unique across all mocks. Never reuse or change it. |
| `domain` | string | A domain `id` from the manifest, such as `"D1"`. |
| `taskStatement` | string | The task statement or objective the question tests. |
| `scenario` | string, optional | Scenario context label, shown above the question (Foundations only). |
| `type` | `"single"` or `"multiple"` | |
| `selectCount` | number | `1` for single; the number of correct options for multiple. |
| `difficulty` | `"easy"`, `"medium"` or `"hard"` | |
| `stem` | string | Blank lines (`\n\n`) separate paragraphs. Backticks mark `inline code`. |
| `options` | array | Each has `id`, `text` and `explanation`. Option ids are unique within the question. |
| `correctOptionIds` | array of strings | Must match option ids. Length equals `selectCount`. |

A complete example:

```json
{
  "id": "fnd1-026",
  "domain": "D2",
  "taskStatement": "2.5 Select and apply built-in tools (Read, Write, Edit, Bash, Grep, Glob) effectively",
  "scenario": "Developer Productivity with Claude",
  "type": "single",
  "selectCount": 1,
  "difficulty": "easy",
  "stem": "An engineer asks a codebase agent to find every place where `calculateTax()` is called in a 3,000-file repository before its signature is changed.\n\nWhich built-in tool should the agent use first?",
  "options": [
    { "id": "a", "text": "Glob, with the pattern `**/*calculateTax*`.", "explanation": "Glob matches file paths. It would find files with that text in their names, not files that call the function." },
    { "id": "b", "text": "Grep, to search file contents for the function name.", "explanation": "Correct. Grep searches the contents of files, which is how callers of a function are located." },
    { "id": "c", "text": "Read, applied to every file under the source directory.", "explanation": "Loading 3,000 files to find a handful of call sites wastes context and time." },
    { "id": "d", "text": "Bash, running a recursive directory listing.", "explanation": "A directory listing shows names and structure, not which files contain the call." }
  ],
  "correctOptionIds": ["b"]
}
```

## Add, edit or fix a question

1. Open the mock's JSON file in `data/`.
2. **To fix wording or an answer key:** edit `stem`, option `text`, `explanation` or `correctOptionIds` in place. Leave `id` and the option `id`s alone.
3. **To reorder questions:** move the objects within the `questions` array. Order in the file is the order shown.
4. **To add a question:** append an object with a new, never-used `id`. Then either remove another question from the same domain or update `questionCount` in the manifest, because the count and the per-domain split are validated.
5. Reload the site and open the browser console. Each mock logs either `[validation] <mock>: OK` or one line per problem. The home screen also shows a warning banner if any mock has problems.

The validation run on load checks that:

- the question count matches `questionCount` in the manifest
- the per-domain counts match the weightings (largest-remainder rounding)
- every `correctOptionIds` entry is a real option
- single-answer questions have exactly one correct option, and multiple-response questions have `selectCount` correct options
- every option has an explanation
- there are no duplicate question ids or option ids

## Add a new mock

1. Create `data/<your-mock>.json` with `mockId`, `title` and a `questions` array.
2. Add an entry to `mocks` in `data/manifest.json`:

```json
{
  "id": "foundations-mock-3",
  "title": "Foundations Mock 3",
  "exam": "Claude Certified Architect – Foundations",
  "examCode": "CCAR-F",
  "questionCount": 60,
  "durationMinutes": 120,
  "passingScore": 72,
  "file": "data/foundations-mock-3.json",
  "domains": [
    { "id": "D1", "name": "Agentic Architecture & Orchestration", "weight": 27 },
    { "id": "D2", "name": "Tool Design & MCP Integration", "weight": 18 },
    { "id": "D3", "name": "Claude Code Configuration & Workflows", "weight": 20 },
    { "id": "D4", "name": "Prompt Engineering & Structured Output", "weight": 20 },
    { "id": "D5", "name": "Context Management & Reliability", "weight": 15 }
  ]
}
```

3. Reload. The new mock appears on its exam's page (matched by `examCode`), and validation runs against the new file. No code changes are needed. To add a new exam level, also add an entry to `exams` in the manifest.

## Keep IDs stable

Visitors' saved progress and attempt history are keyed by **mock id** and **question id**, never by position.

- Never change the `id` of an existing mock or question, and never reuse a retired id for a different question.
- Do not change option `id`s on existing questions. Saved answers refer to them.
- Editing text, fixing an answer key and reordering questions are all safe.
- Adding or removing questions changes the set of ids in a mock. Any visitor with an attempt in progress on that mock has it discarded with a short notice the next time they open the site. Completed reports stay readable; a removed question shows a placeholder in old reports.
- Storage keys are versioned (`mockexam:v1:...`). If you ever change the shape of the saved data, bump the version in `js/app.js` so old data is ignored instead of misread.

## Stored data

| Key | Contents |
|---|---|
| `mockexam:v1:theme` | `"light"` or `"dark"` |
| `mockexam:v1:attempt:<mockId>` | The in-progress attempt for that mock: answers, flags, current question, remaining time |
| `mockexam:v1:history` | Completed attempts with their reports (most recent 200) |

"Clear all data" at the bottom of each exam page removes the attempt and history keys.
