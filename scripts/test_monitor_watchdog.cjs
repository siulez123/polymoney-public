const {test} = require('node:test');
const assert = require('node:assert/strict');
const {watchdog, complete, age} = require('./monitor_watchdog.cjs');
const now = Date.parse('2026-09-16T08:00:00Z');
const run = {id: 42, head_branch: 'main', event: 'schedule', status: 'completed',
  conclusion: 'success', created_at: '2026-09-16T07:30:00Z', html_url: 'https://github.com/example/run/42'};
const artifacts = ['report', 'backtest-summary', 'prospective-summary', 'opportunity-summary']
  .map(p => ({name: `polymoney-${p}-42`, expired: false, size_in_bytes: 100}));

async function execute(runs, files = artifacts, issues = []) {
  const calls = [];
  const record = name => async args => {calls.push({name, args}); return {};};
  const github = {rest: {actions: {
    listWorkflowRuns: async () => ({data: {workflow_runs: runs}}),
    listWorkflowRunArtifacts: 'artifacts', createWorkflowDispatch: record('dispatch'),
  }, issues: {listForRepo: 'issues', create: record('create'), update: record('update'), createComment: record('comment')}},
  paginate: async method => method === 'artifacts' ? files : issues};
  const result = await watchdog({github, now,
    context: {repo: {owner: 'owner', repo: 'repo'}, serverUrl: 'https://github.com', runId: 99},
    core: {info() {}, warning() {}}});
  return {result, calls};
}
test('complete fresh collection performs no mutation', async () => {
  assert.deepEqual(await execute([run]), {result: 'fresh', calls: []});
});
test('missing, failed, old or incomplete evidence alerts and dispatches only monitor main', async () => {
  for (const [runs, files] of [[[], []], [[{...run, conclusion: 'failure'}], artifacts],
    [[{...run, created_at: '2026-09-16T05:00:00Z'}], artifacts], [[run], artifacts.slice(1)]]) {
    const {result, calls} = await execute(runs, files);
    assert.equal(result, 'dispatched');
    assert.deepEqual(calls.map(c => c.name), ['create', 'dispatch']);
    assert.deepEqual(calls[1].args, {owner: 'owner', repo: 'repo', workflow_id: 'monitor-polymoney.yml', ref: 'main'});
  }
});
test('expired and empty artifacts do not confirm freshness', () => {
  for (const change of [{expired: true}, {size_in_bytes: 0}])
    assert.equal(complete(run, [{...artifacts[0], ...change}, ...artifacts.slice(1)]), false);
});
test('queued running waiting monitors and recent dispatch suppress retry', async () => {
  for (const change of [{status: 'queued'}, {status: 'in_progress'}, {status: 'waiting'},
    {event: 'workflow_dispatch', conclusion: 'failure'}]) {
    const {result, calls} = await execute([{...run, ...change}]);
    assert.equal(result, 'waiting');
    assert.deepEqual(calls.map(c => c.name), ['create']);
  }
});
test('old failed dispatch can retry; foreign branch cannot certify health', async () => {
  assert.equal((await execute([{...run, event: 'workflow_dispatch', conclusion: 'failure',
    created_at: '2026-09-16T06:00:00Z'}])).result, 'dispatched');
  assert.equal((await execute([{...run, head_branch: 'feature'}])).result, 'dispatched');
});
test('recovery comments and closes only dedicated incident', async () => {
  const incident = {number: 77, title: '[agent] Stale monitoring report'};
  const {calls} = await execute([run], artifacts, [incident]);
  assert.deepEqual(calls.map(c => c.name), ['comment', 'update']);
  assert.equal(calls[1].args.state, 'closed');
  assert.equal(calls[1].args.issue_number, 77);
  const stale = await execute([], [], [incident]);
  assert.equal(stale.calls[0].name, 'update');
});
test('malformed/future time and rerun updated_at cannot refresh old run', () => {
  for (const date of ['bad', '2026-09-16T09:00:00Z'])
    assert.equal(age({...run, created_at: date}, now), Infinity);
  assert.equal(age({...run, created_at: '2026-09-16T05:00:00Z', updated_at: run.created_at}, now), 10800000);
});

