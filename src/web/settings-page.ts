import { COUNTRY_GROUPS, DEFAULT_COUNTRIES, DEFAULT_GENRES, GENRE_NAMES } from '../config.js';
import type { CurrentRun, RunRow } from '../jobs/runner.js';
import { CHART_LABELS, CHART_LIMITS, CHARTS, estimate, type ParseSettings } from '../settings.js';
import { ago, esc, fmt, page } from './ui.js';

export interface Flash {
  kind: 'ok' | 'bad';
  text: string;
}

const GENRE_GROUPS: Array<{ title: string; ids: string[] }> = [
  { title: 'Общий топ', ids: ['all'] },
  { title: 'Игры', ids: Object.keys(GENRE_NAMES).filter((id) => id === '6014' || id.startsWith('70')) },
  { title: 'Приложения', ids: Object.keys(GENRE_NAMES).filter((id) => id.startsWith('60') && id !== '6014') },
];

const GAME_IDS = GENRE_GROUPS[1].ids;

const STATUS_LABEL: Record<string, string> = {
  running: '<span class="warn">идёт</span>',
  done: '<span class="ok">готово</span>',
  failed: '<span class="bad">ошибка</span>',
  interrupted: '<span class="bad">прерван</span>',
};

function duration(r: RunRow): string {
  const end = r.finished_at ? new Date(r.finished_at) : new Date();
  const min = Math.round((end.getTime() - new Date(r.started_at).getTime()) / 60_000);
  return min < 1 ? '<1 мин' : `${min} мин`;
}

function runSummary(r: RunRow): string {
  if (r.error) return `<span class="bad">${esc(r.error)}</span>`;
  if (!r.result) return '';
  if (r.params?.kind === 'contacts') {
    return `проверено ${fmt(r.result.contactsChecked)}, почта у ${fmt(r.result.contactsFound)}, LinkedIn у ${fmt(r.result.linkedinFound)}`;
  }
  const failed = r.result.failedCharts?.length ?? 0;
  const llmErrors = r.result.llmErrors ?? 0;
  return `просканировано ${fmt(r.result.scanned)}, оценено ${fmt(r.result.saved)}, почта +${fmt(r.result.contactsFound)}${failed ? ` · <span class="warn">чартов не пришло: ${failed}</span>` : ''}${llmErrors ? ` · <span class="warn">ошибок оценки: ${llmErrors}</span>` : ''}`;
}

function scope(r: RunRow): string {
  const p = r.params;
  if (!p) return '';
  if (p.kind === 'contacts') return 'контакты и LinkedIn';
  return `${p.countries?.length ?? 0} стран × ${p.genres?.length ?? 0} кат. × ${p.charts?.length ?? 0} чарт.`;
}

const check = (name: string, value: string, label: string, checked: boolean, extra = '') =>
  `<label class="chk"><input type="checkbox" name="${name}" value="${esc(value)}"${checked ? ' checked' : ''} ${extra}> ${esc(label)}</label>`;

export function renderSettingsPage(o: { settings: ParseSettings; run: CurrentRun | null; runs: RunRow[]; flash?: Flash }): string {
  const s = o.settings;
  const est = estimate(s);
  const has = (list: string[], v: string) => list.includes(v);

  const countries = COUNTRY_GROUPS.map(
    (g) => `<fieldset class="group" data-group>
      <legend><label class="chk"><input type="checkbox" data-region> ${esc(g.region)}</label></legend>
      ${Object.entries(g.countries)
        .map(([code, name]) => check('countries', code, `${name} (${code})`, has(s.countries, code)))
        .join('')}
    </fieldset>`,
  ).join('');

  const genres = GENRE_GROUPS.map(
    (g) => `<fieldset class="group" data-group>
      <legend><label class="chk"><input type="checkbox" data-region> ${esc(g.title)}</label></legend>
      ${g.ids.map((id) => check('genres', id, id === 'all' ? 'Все приложения (общий чарт)' : GENRE_NAMES[id], has(s.genres, id))).join('')}
    </fieldset>`,
  ).join('');

  const charts = CHARTS.map((c) => check('charts', c, CHART_LABELS[c], has(s.charts, c))).join('');
  const limits = CHART_LIMITS.map(
    (l) => `<label class="chk"><input type="radio" name="chartLimit" value="${l}"${s.chartLimit === l ? ' checked' : ''}> топ-${l}</label>`,
  ).join('');

  const running = o.run;
  const status = running
    ? `<p>Идёт сбор <b>#${running.id}</b>: <span id="run-stage" class="warn">${esc(running.stage)}</span> · начат ${esc(ago(running.startedAt))}</p>`
    : `<p class="mut">Сейчас ничего не идёт.</p>`;

  const runsTable = o.runs.length
    ? `<div class="wrap"><table class="runs"><thead><tr><th>#</th><th>Начат</th><th>Как</th><th>Выборка</th><th>Статус</th><th>Длит.</th><th>Итог</th></tr></thead><tbody>
      ${o.runs
        .map(
          (r) => `<tr><td>${r.id}</td><td>${esc(new Date(r.started_at).toLocaleString('ru-RU'))}</td>
          <td>${r.trigger === 'ui' ? 'кнопка' : r.trigger === 'api' ? 'по API' : esc(r.trigger)}</td>
          <td class="small">${esc(scope(r))}</td><td>${STATUS_LABEL[r.status] ?? esc(r.status)}</td>
          <td>${duration(r)}</td><td class="small">${runSummary(r)}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : '<p class="mut">Прогонов ещё не было.</p>';

  const body = `
  <h1>Что парсить</h1>
  <p class="sub">Выборка для сбора лидов из топ-чартов App Store. Сохраняется на сервере и применяется к следующему прогону.</p>
  ${o.flash ? `<div class="flash ${o.flash.kind}">${esc(o.flash.text)}</div>` : ''}

  <div class="card"><h2>Статус</h2>${status}
    <form method="post" action="/runs/contacts" class="bar">
      <button type="submit"${running ? ' disabled title="Сбор уже идёт"' : ''}>Дособрать контакты и LinkedIn</button>
      <span class="mut small">Без модели: почта и LinkedIn для уже найденных лидов, у которых их ещё не искали. Работает и при исчерпанном лимите Anthropic.</span>
    </form>
    ${runsTable}</div>

  <form method="post" action="/settings" id="f">
    <div class="card">
      <h2>Страны</h2>
      <div class="bar">
        <button type="button" data-preset="countries" data-values="${esc(DEFAULT_COUNTRIES.join(','))}">Топ-20 по выручке</button>
        <button type="button" data-preset="countries" data-values="*">Все</button>
        <button type="button" data-preset="countries" data-values="">Снять все</button>
      </div>
      <div class="groups">${countries}</div>
    </div>

    <div class="card">
      <h2>Категории</h2>
      <p class="mut small">В общем топе одни гиганты — средний сегмент находится в чартах категорий.</p>
      <div class="bar">
        <button type="button" data-preset="genres" data-values="${esc(DEFAULT_GENRES.join(','))}">Игры и утилиты (по умолчанию)</button>
        <button type="button" data-preset="genres" data-values="${esc(GAME_IDS.join(','))}">Только игры</button>
        <button type="button" data-preset="genres" data-values="*">Все</button>
        <button type="button" data-preset="genres" data-values="">Снять все</button>
      </div>
      <div class="groups">${genres}</div>
    </div>

    <div class="card cols">
      <div><h2>Чарты</h2>${charts}</div>
      <div><h2>Глубина</h2>${limits}<p class="mut small">Глубже — больше средних и небольших приложений.</p></div>
    </div>

    <div class="card">
      <h2>Оценка и фильтры</h2>
      <div class="fields">
        <label>Оценивать моделью не больше, приложений за прогон
          <input type="number" name="maxLlmPerRun" min="0" max="2000" value="${s.maxLlmPerRun}"></label>
        <label>Не брать приложения, у которых отзывов больше
          <input type="number" name="maxAppRatings" min="100" value="${s.maxAppRatings}"></label>
        <label>Не брать издателей, у которых отзывов на все приложения больше
          <input type="number" name="maxPublisherRatings" min="1000" value="${s.maxPublisherRatings}"></label>
      </div>
      <label class="block">Исключить издателей (часть названия, по одному в строке)
        <textarea name="excludePublishers" rows="6">${esc(s.excludePublishers.join('\n'))}</textarea></label>
    </div>

    <div class="card sticky">
      <p id="est">${est.charts} чартов · ~${est.minutes} мин при первом сборе · оценка до ${s.maxLlmPerRun} приложений ≈ $${est.llmCostUsd}</p>
      <p class="mut small">Повторный сбор в течение 12 часов берёт чарты из кэша и идёт быстрее. Уже оценённые за неделю приложения модель не переоценивает.</p>
      <div class="bar">
        <button type="submit" name="action" value="save">Сохранить</button>
        <button type="submit" name="action" value="run" class="primary"${running ? ' disabled title="Сбор уже идёт"' : ''}>Сохранить и запустить сбор</button>
      </div>
    </div>
  </form>

  <script>
  (function () {
    var f = document.getElementById('f');
    function boxes(name) { return Array.prototype.slice.call(f.querySelectorAll('input[name="' + name + '"]')); }
    function syncRegions() {
      f.querySelectorAll('[data-group]').forEach(function (g) {
        var items = g.querySelectorAll('input[name]');
        var on = g.querySelectorAll('input[name]:checked').length;
        var r = g.querySelector('[data-region]');
        r.checked = on === items.length; r.indeterminate = on > 0 && on < items.length;
      });
    }
    function update() {
      var n = function (name) { return f.querySelectorAll('input[name="' + name + '"]:checked').length; };
      var c = n('countries'), g = n('genres'), ch = n('charts');
      var total = c * g * ch, min = Math.max(1, Math.round(total * 3 / 60));
      var llm = Number(f.maxLlmPerRun.value) || 0;
      document.getElementById('est').textContent = c + ' стран × ' + g + ' категорий × ' + ch + ' чарта = ' + total +
        ' чартов · ~' + min + ' мин при первом сборе · оценка до ' + llm + ' приложений ≈ $' + (llm * 0.006).toFixed(2);
      syncRegions();
    }
    f.querySelectorAll('[data-region]').forEach(function (r) {
      r.addEventListener('change', function () {
        r.closest('[data-group]').querySelectorAll('input[name]').forEach(function (i) { i.checked = r.checked; });
        update();
      });
    });
    f.querySelectorAll('[data-preset]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-values'), set = v === '*' ? null : v.split(',');
        boxes(b.getAttribute('data-preset')).forEach(function (i) { i.checked = set === null || set.indexOf(i.value) >= 0; });
        update();
      });
    });
    f.addEventListener('change', update);
    f.addEventListener('input', update);
    update();
    ${
      running
        ? `setInterval(function () {
      fetch('/api/run-status').then(function (r) { return r.json(); }).then(function (s) {
        if (!s.current) { location.reload(); return; }
        var el = document.getElementById('run-stage'); if (el) el.textContent = s.current.stage;
      }).catch(function () {});
    }, 5000);`
        : ''
    }
  })();
  </script>`;

  return page({
    title: 'Что парсить',
    active: 'settings',
    run: o.run,
    body,
    css: `
      .groups{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
      fieldset.group{border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:0}
      fieldset.group legend{padding:0 4px;font-weight:600}
      .chk{display:block;padding:2px 0;cursor:pointer} .chk input{margin-right:6px}
      .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
      .fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:12px}
      label input[type=number],textarea{display:block;width:100%;margin-top:4px;padding:6px 8px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit}
      label.block{display:block}
      .sticky{position:sticky;bottom:0;border-color:var(--acc)}
      #est{font-weight:600;margin:0 0 4px}
      table.runs{min-width:720px}
    `,
  });
}
