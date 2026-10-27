import { pool } from '../db/pool.js';
import { getParseSettings } from '../settings.js';
import { llmKeyMissing, runCompanies, runPipeline, type HunterRunResult, type LinkedInSearchResult } from './run-pipeline.js';

/**
 * Запуск прохода из дашборда или по API: не больше одного одновременно (сервис на Railway
 * в одном экземпляре), история в таблице runs, текущий этап — в памяти для страницы статуса.
 */

export type RunTrigger = 'ui' | 'api';

/** full — сбор, оценка и контакты; contacts — только дособрать контакты компаний, LinkedIn и Hunter (без модели). */
export type RunKind = 'full' | 'contacts';

export interface CurrentRun {
  id: number;
  kind: RunKind;
  trigger: RunTrigger;
  startedAt: Date;
  stage: string;
}

let current: CurrentRun | null = null;

export function currentRun(): CurrentRun | null {
  return current;
}

/** Прогоны, оборванные перезапуском сервера (деплой), помечаем — иначе висят как «идёт». */
export async function markInterruptedRuns(): Promise<void> {
  await pool.query(
    `UPDATE runs SET status = 'interrupted', finished_at = now(), error = 'сервер перезапустился во время прохода'
     WHERE status = 'running'`,
  );
}

export async function startRun(
  trigger: RunTrigger,
  kind: RunKind = 'full',
): Promise<{ started: true; id: number } | { started: false; reason: string }> {
  if (current) return { started: false, reason: `проход #${current.id} уже идёт (${current.stage})` };
  if (kind === 'full') {
    const missingKey = llmKeyMissing();
    if (missingKey) return { started: false, reason: `${missingKey} не задан на сервере` };
  }

  const settings = await getParseSettings();
  const { rows } = await pool.query(
    `INSERT INTO runs (trigger, status, params) VALUES ($1, 'running', $2) RETURNING id`,
    [trigger, JSON.stringify({ kind, ...settings })],
  );
  const run: CurrentRun = { id: rows[0].id, kind, trigger, startedAt: new Date(), stage: 'старт' };
  current = run;

  const report = (stage: string) => (run.stage = stage);
  const work =
    kind === 'contacts'
      ? runCompanies(report).then((r) => ({
          contactsChecked: r.checked,
          contactsFound: r.withEmail,
          personalFound: r.withPersonal,
          linkedinFound: r.linkedinSite,
          linkedin: r.linkedin,
          hunter: r.hunter,
        }))
      : runPipeline({ settings, report });
  work
    .then((result) =>
      pool.query(`UPDATE runs SET status = 'done', result = $2, finished_at = now() WHERE id = $1`, [run.id, JSON.stringify(result)]),
    )
    .catch((e) =>
      pool.query(`UPDATE runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [run.id, (e as Error).message]),
    )
    .catch((e) => console.error('не удалось записать итог прохода', e))
    .finally(() => {
      if (current?.id === run.id) current = null;
    });

  return { started: true, id: run.id };
}

export interface RunRow {
  id: number;
  trigger: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  result: {
    scanned?: number; saved?: number; contactsChecked?: number; contactsFound?: number; personalFound?: number;
    linkedinFound?: number; llmErrors?: number; failedCharts?: string[]; linkedin?: LinkedInSearchResult;
    hunter?: HunterRunResult;
  } | null;
  error: string | null;
  params: { kind?: RunKind; countries?: string[]; genres?: string[]; charts?: string[] } | null;
}

export async function recentRuns(limit = 8): Promise<RunRow[]> {
  const { rows } = await pool.query(
    `SELECT id, trigger, status, started_at, finished_at, result, error, params
     FROM runs ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  return rows;
}
