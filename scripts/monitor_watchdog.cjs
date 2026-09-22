// GitHub metadata only: no VPS credentials, data downloads or trading endpoints.
const WORKFLOW = 'monitor-polymoney.yml';
const TITLE = '[agent] Relatório de monitorização desatualizado';
const PREFIXES = ['report', 'backtest-summary', 'prospective-summary', 'opportunity-summary'];
const MAX_AGE = 120 * 60 * 1000;
const COOLDOWN = 60 * 60 * 1000;

function age(run, now) {
  // Creation time is conservative: reruns must not refresh old evidence.
  const timestamp = Date.parse(run.created_at);
  return Number.isFinite(timestamp) && timestamp <= now ? now - timestamp : Infinity;
}
function complete(run, artifacts) {
  return run.status === 'completed' && run.conclusion === 'success'
    && PREFIXES.every(prefix => artifacts.some(a =>
      a.name === `polymoney-${prefix}-${run.id}` && !a.expired && a.size_in_bytes > 0));
}

async function watchdog({github, context, core, now = Date.now()}) {
  const repo = context.repo;
  const {data} = await github.rest.actions.listWorkflowRuns({
    ...repo, workflow_id: WORKFLOW, branch: 'main', per_page: 100,
  });
  const runs = data.workflow_runs.filter(r => r.head_branch === 'main'
    && ['schedule', 'workflow_dispatch', 'workflow_run'].includes(r.event));
  let fresh;
  for (const run of runs.filter(r => age(r, now) <= MAX_AGE)) {
    if (run.status !== 'completed' || run.conclusion !== 'success') continue;
    const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts,
      {...repo, run_id: run.id});
    if (complete(run, artifacts)) { fresh = run; break; }
  }
  const issues = await github.paginate(github.rest.issues.listForRepo,
    {...repo, state: 'open', creator: 'github-actions[bot]'});
  const existing = issues.find(i => !i.pull_request && i.title === TITLE);
  if (fresh) {
    if (existing) {
      await github.rest.issues.createComment({...repo, issue_number: existing.number,
        body: `Recolha completa recuperada: ${fresh.html_url}. A recuperação não valida estratégias.`});
      await github.rest.issues.update({...repo, issue_number: existing.number, state: 'closed'});
    }
    core.info(`Monitorização recente e completa: ${fresh.id}`);
    return 'fresh';
  }
  const body = 'Sem monitor concluído com sucesso e quatro artefactos nos últimos 120 minutos. '
    + 'Estado atual não confirmado. O watchdog partilha o agendamento do GitHub Actions; '
    + 'uma interrupção geral pode atrasar também este alerta.\n\n'
    + `Verificação: ${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`;
  if (existing) await github.rest.issues.update({...repo, issue_number: existing.number, body});
  else await github.rest.issues.create({...repo, title: TITLE, body});
  // Never pile up work behind an active/queued monitor or retry more than hourly.
  const active = runs.some(r => r.status !== 'completed');
  const recentDispatch = runs.some(r => r.event === 'workflow_dispatch' && age(r, now) < COOLDOWN);
  if (!active && !recentDispatch) {
    await github.rest.actions.createWorkflowDispatch({...repo, workflow_id: WORKFLOW, ref: 'main'});
    core.warning('Relatório atrasado; solicitada uma recolha sem alterar trading.');
    return 'dispatched';
  }
  core.warning('Relatório atrasado; recolha pendente ou intervalo entre tentativas ainda ativo.');
  return 'waiting';
}
module.exports = {watchdog, complete, age};

