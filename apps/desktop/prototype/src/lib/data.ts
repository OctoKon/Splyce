import type {
  DiffFile,
  LocalModel,
  McpServer,
  MemoryItem,
  Receipt,
  Role,
  Run,
  Skill,
  Workspace,
} from './types';

export const workspaces: Workspace[] = [
  {
    id: 'payments',
    name: 'payments-api',
    path: '~/dev/payments-api',
    branch: 'main',
    files: 214,
    local: true,
  },
  {
    id: 'console',
    name: 'console',
    path: '~/dev/console',
    branch: 'main',
    files: 486,
    local: true,
  },
  {
    id: 'docs',
    name: 'runtime-docs',
    path: '~/dev/runtime-docs',
    branch: 'main',
    files: 92,
    local: true,
  },
];

export const activeWorkspace = workspaces[0];

export const runs: Run[] = [];

export const diffFiles: DiffFile[] = [
  {
    path: 'src/webhooks/verify.ts',
    additions: 18,
    deletions: 6,
    hunks: [
      {
        header: '@@ -12,9 +12,14 @@ export async function verifySignature(input: Input)',
        lines: [
          { kind: 'context', number: 12, text: '  const raw = await readBody(input.request);' },
          { kind: 'del', number: 13, text: "  const timestamp = input.headers['x-timestamp'];" },
          { kind: 'del', number: 14, text: '  if (!timestamp) return false;' },
          {
            kind: 'add',
            number: 13,
            text: "  const timestamp = header(input.headers, 'x-timestamp');",
          },
          { kind: 'add', number: 14, text: '  if (!timestamp) {' },
          {
            kind: 'add',
            number: 15,
            text: '    // Missing timestamps fail before the HMAC comparison.',
          },
          { kind: 'add', number: 16, text: "    return rejected('missing_timestamp');" },
          { kind: 'add', number: 17, text: '  }' },
          { kind: 'context', number: 18, text: '  const age = Date.now() - Number(timestamp);' },
          { kind: 'del', number: 19, text: '  if (age > MAX_AGE) return false;' },
          {
            kind: 'add',
            number: 19,
            text: "  if (age > MAX_AGE) return rejected('stale_timestamp');",
          },
        ],
      },
    ],
  },
  {
    path: 'src/webhooks/verify.test.ts',
    additions: 21,
    deletions: 0,
    hunks: [
      {
        header: "@@ -84,6 +84,27 @@ describe('verifySignature', () => {",
        lines: [
          { kind: 'context', number: 84, text: "  it('accepts a fresh signature', async () => {" },
          {
            kind: 'context',
            number: 85,
            text: '    await expect(verify(fixture())).resolves.toBe(true);',
          },
          { kind: 'context', number: 86, text: '  });' },
          { kind: 'add', number: 87, text: '' },
          {
            kind: 'add',
            number: 88,
            text: "  it('rejects a missing timestamp header', async () => {",
          },
          { kind: 'add', number: 89, text: '    const request = fixture({ headers: {} });' },
          {
            kind: 'add',
            number: 90,
            text: '    await expect(verifySignature(request)).resolves.toEqual({',
          },
          { kind: 'add', number: 91, text: "      ok: false, reason: 'missing_timestamp'," },
          { kind: 'add', number: 92, text: '    });' },
          { kind: 'add', number: 93, text: '  });' },
        ],
      },
    ],
  },
  {
    path: 'src/http/headers.ts',
    additions: 3,
    deletions: 5,
    hunks: [
      {
        header: '@@ -3,11 +3,9 @@ export function header(headers: Headers, name: string)',
        lines: [
          { kind: 'context', number: 3, text: '  const key = name.toLowerCase();' },
          { kind: 'del', number: 4, text: '  return headers[key] ?? headers[key.toUpperCase()];' },
          {
            kind: 'add',
            number: 4,
            text: '  return headers[key] ?? headers[key.toUpperCase()] ?? null;',
          },
          { kind: 'context', number: 5, text: '}' },
        ],
      },
    ],
  },
];

export const receipts: Receipt[] = [
  {
    id: 'rc-8841',
    kind: 'verification',
    label: 'npm test -- webhooks',
    detail: 'exit 0 · 24 tests · 1.8s',
    at: '12:41:08',
    state: 'ok',
  },
  {
    id: 'rc-8840',
    kind: 'action',
    label: 'edit src/webhooks/verify.ts',
    detail: 'policy allow · workspace write',
    at: '12:40:52',
    state: 'ok',
  },
  {
    id: 'rc-8839',
    kind: 'verification',
    label: 'npm test -- webhooks',
    detail: 'exit 1 · 2 failed',
    at: '12:40:19',
    state: 'failed',
  },
  {
    id: 'rc-8838',
    kind: 'action',
    label: 'read src/http/headers.ts',
    detail: 'policy allow · read only',
    at: '12:39:44',
    state: 'ok',
  },
  {
    id: 'rc-8837',
    kind: 'intent',
    label: 'run task r-1042',
    detail: 'base a3f91c2 · local only',
    at: '12:39:31',
    state: 'ok',
  },
];

export const memoryItems: MemoryItem[] = [
  {
    id: 'm-201',
    kind: 'decision',
    title: 'Missing timestamps must fail before HMAC comparison',
    excerpt:
      'Reject a webhook before computing the signature when x-timestamp is absent. Returning false after comparison hid the root cause and produced misleading test failures.',
    source: 'src/webhooks/verify.ts:13',
    revision: 'a3f91c2',
    runId: 'r-1042',
    workspace: 'payments-api',
    age: '12m ago',
    used: 2,
    evidence: [
      'verify.ts lines 13–17 · rejected(missing_timestamp)',
      'verify.test.ts · regression case "rejects a missing timestamp header"',
      'receipt rc-8841 · exit 0 · 24 tests',
    ],
  },
  {
    id: 'm-198',
    kind: 'failure',
    title: 'Vitest fake timers leaked across auth suites',
    excerpt:
      'restoreMocks is not enough. The suite must call vi.useRealTimers() in afterEach or later suites time out while awaiting the token clock.',
    source: 'src/auth/session.test.ts:22',
    revision: '7c2d1e0',
    runId: 'r-1038',
    workspace: 'console',
    age: '1h ago',
    used: 1,
    evidence: ['session.test.ts lines 22–28 · afterEach', 'receipt rc-8733 · exit 0 · 61 tests'],
  },
  {
    id: 'm-193',
    kind: 'decision',
    title: 'Invoices use opaque keyset cursors',
    excerpt:
      'Pagination exposes a signed cursor with (created_at, id). Offset fallback was removed because mutable invoice ordering produced duplicate rows.',
    source: 'src/invoices/pagination.ts:41',
    revision: 'a3f91c2',
    runId: 'r-1041',
    workspace: 'payments-api',
    age: '26m ago',
    used: 3,
    evidence: [
      'pagination.ts lines 41–66 · encodeCursor',
      'contract test · stable page under inserts',
    ],
  },
  {
    id: 'm-187',
    kind: 'capsule',
    title: 'Session 38 · payments-api',
    excerpt:
      'Hardened webhook verification, added two regression cases, and re-ran the webhook suite. Final diff bound to base a3f91c2 with a passing receipt.',
    source: 'journal/sessions/s-38',
    revision: 'a3f91c2',
    runId: 'r-1042',
    workspace: 'payments-api',
    age: '2h ago',
    used: 0,
    evidence: ['summary revision ext-4 · 3 cited decisions', 'artifacts: diff-1042, test-8841'],
  },
  {
    id: 'm-181',
    kind: 'decision',
    title: 'Use offset pagination for invoices',
    excerpt:
      'Offset pagination is simpler for the first release and works with the existing table.',
    source: 'src/invoices/pagination.ts:8',
    revision: 'f20c991',
    runId: 'r-1019',
    workspace: 'payments-api',
    age: '6d ago',
    used: 0,
    superseded: 'superseded by m-193',
    evidence: ['superseded 3d ago after duplicate-row reproduction'],
  },
  {
    id: 'm-176',
    kind: 'failure',
    title: 'Applying at a stale base is blocked before write',
    excerpt:
      'The workspace moved between verification and apply. Splyce refused the patch and reported an uncertain effect rather than replaying it.',
    source: 'journal/runs/r-1036',
    revision: 'e11a907',
    runId: 'r-1036',
    workspace: 'gateway',
    age: '3h ago',
    used: 1,
    evidence: ['receipt rc-8610 · policy hold', 'receipt rc-8611 · conflict'],
  },
];

export const roles: Role[] = [
  {
    id: 'generation',
    label: 'Generation',
    job: 'Turn execution, edits, plans',
    model: 'Qwen3-Coder-30B-A3B',
    runtime: 'llama.cpp · Q4_K_M',
    state: 'loaded',
    locality: 'verified',
    detail: '128k context · 41 tok/s',
  },
  {
    id: 'extraction',
    label: 'Extraction',
    job: 'Memory observations, structured summaries',
    model: 'Qwen3-4B-Instruct',
    runtime: 'llama.cpp · Q5_K_M',
    state: 'loaded',
    locality: 'verified',
    detail: '32k context · 96 tok/s',
  },
  {
    id: 'embeddings',
    label: 'Embeddings',
    job: 'Memory index · generation 4',
    model: 'nomic-embed-text-v1.5',
    runtime: 'ONNX · CPU',
    state: 'ready',
    locality: 'verified',
    detail: '768d · 1,284 chunks',
  },
  {
    id: 'reranking',
    label: 'Reranking',
    job: 'Progressive evidence retrieval',
    model: 'bge-reranker-v2-m3',
    runtime: 'ONNX · CPU',
    state: 'idle',
    locality: 'verified',
    detail: 'Top 24 · 2.1k ctx',
  },
];

export const localModels: LocalModel[] = [
  {
    id: 'qwen-coder-30b',
    name: 'Qwen3-Coder-30B-A3B',
    params: '30B · 3B active',
    quant: 'Q4_K_M',
    size: '18.4 GB',
    runtime: 'llama.cpp',
    roles: ['generation', 'extraction'],
    installed: true,
  },
  {
    id: 'qwen-4b',
    name: 'Qwen3-4B-Instruct',
    params: '4B',
    quant: 'Q5_K_M',
    size: '2.9 GB',
    runtime: 'llama.cpp',
    roles: ['extraction'],
    installed: true,
  },
  {
    id: 'nomic-embed',
    name: 'nomic-embed-text-v1.5',
    params: '137M',
    quant: 'F16',
    size: '548 MB',
    runtime: 'ONNX',
    roles: ['embeddings'],
    installed: true,
  },
  {
    id: 'bge-reranker',
    name: 'bge-reranker-v2-m3',
    params: '568M',
    quant: 'F16',
    size: '1.1 GB',
    runtime: 'ONNX',
    roles: ['reranking'],
    installed: true,
  },
  {
    id: 'devstral-24b',
    name: 'Devstral-Small-24B',
    params: '24B',
    quant: 'Q4_K_M',
    size: '14.2 GB',
    runtime: 'llama.cpp',
    roles: ['generation'],
    installed: false,
  },
  {
    id: 'llama-70b',
    name: 'Llama-3.3-70B-Instruct',
    params: '70B',
    quant: 'Q4_K_M',
    size: '42.5 GB',
    runtime: 'llama.cpp',
    roles: ['generation'],
    installed: false,
  },
];

export const mcpServers: McpServer[] = [
  {
    id: 'mcp-fs',
    name: 'filesystem',
    command: 'npx @modelcontextprotocol/server-filesystem ~/dev/payments-api',
    transport: 'stdio',
    version: '0.6.2',
    tools: 8,
    grant: 'Read-only',
    enabled: true,
    tools_list: [
      { name: 'read_file', scope: 'workspace read' },
      { name: 'list_directory', scope: 'workspace read' },
      { name: 'search_files', scope: 'workspace read' },
      { name: 'write_file', scope: 'blocked by grant' },
    ],
  },
  {
    id: 'mcp-git',
    name: 'git',
    command: 'npx @modelcontextprotocol/server-git --repository ~/dev/payments-api',
    transport: 'stdio',
    version: '0.6.2',
    tools: 12,
    grant: 'Workspace write',
    enabled: true,
    tools_list: [
      { name: 'git_status', scope: 'workspace read' },
      { name: 'git_diff', scope: 'workspace read' },
      { name: 'git_add', scope: 'workspace write' },
      { name: 'git_commit', scope: 'requires approval' },
    ],
  },
  {
    id: 'mcp-sqlite',
    name: 'sqlite',
    command: 'npx @modelcontextprotocol/server-sqlite ./tmp/dev.db',
    transport: 'stdio',
    version: '0.5.1',
    tools: 4,
    grant: 'Read-only',
    enabled: false,
    tools_list: [
      { name: 'read_query', scope: 'database read' },
      { name: 'write_query', scope: 'blocked by grant' },
    ],
  },
  {
    id: 'mcp-browser',
    name: 'local-browser',
    command: 'splyce-mcp-browser --profile dev',
    transport: 'stdio',
    version: '0.2.0',
    tools: 6,
    grant: 'Network',
    enabled: false,
    tools_list: [
      { name: 'open_page', scope: 'localhost only' },
      { name: 'read_page', scope: 'localhost only' },
      { name: 'screenshot', scope: 'artifact write' },
    ],
  },
];

export const skills: Skill[] = [
  {
    id: 'sk-rust',
    name: 'rust-change-verification',
    description:
      'Verify Rust changes with fmt, clippy, build and tests before reporting completion. Requires an exact command receipt.',
    provenance: 'OctoKon/Splyce · main@d5b3de2',
    version: '1.0.0',
    scope: 'Workspace',
    enabled: true,
  },
  {
    id: 'sk-evidence',
    name: 'evidence-research',
    description:
      'Trace each claim to a pinned source. Mark unverified assertions as hypotheses instead of facts.',
    provenance: 'OctoKon/Splyce · main@d5b3de2',
    version: '1.2.0',
    scope: 'Workspace',
    enabled: true,
  },
  {
    id: 'sk-root',
    name: 'root-cause-debugging',
    description:
      'Reproduce the failure, narrow the smallest cause, fix once in shared code and add a regression check.',
    provenance: 'OctoKon/Splyce · main@d5b3de2',
    version: '0.9.0',
    scope: 'Workspace',
    enabled: true,
  },
  {
    id: 'sk-handoff',
    name: 'session-handoff',
    description:
      'Write a compact handoff with evidence IDs, unresolved effects and the next safe action before stopping.',
    provenance: 'OctoKon/Splyce · main@d5b3de2',
    version: '1.1.0',
    scope: 'Run',
    enabled: false,
  },
  {
    id: 'sk-eval',
    name: 'evaluation-gates',
    description:
      'Freeze the task, model and environment before comparing runs. Report failures and uncertainty alongside a result.',
    provenance: 'OctoKon/Splyce · main@d5b3de2',
    version: '0.4.0',
    scope: 'Workspace',
    enabled: false,
  },
];
