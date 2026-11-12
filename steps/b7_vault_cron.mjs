import { StepError, describe } from '../lib/errors.mjs';
import { dbConn } from '../lib/conn.mjs';
import { withDb } from '../lib/db.mjs';
import { readJson } from '../lib/util.mjs';
import { hosts } from './common.mjs';

export default {
  id: 'b7',
  phase: 'B',
  num: 'B7',
  title: 'Create Vault secrets and cron jobs',
  desc: 'Creates the Vault secrets (URLs now point to the new project) and then the scheduled jobs. Last, so nothing runs on half-copied data.',
  requires: ['b4', 'b5'],
  writes: 'new',
  confirm: 'This starts the scheduled jobs in the NEW project. Continue?',
  async run(ctx) {
    const { cfg, paths } = ctx;
    const { oldHost, newHost } = hosts(cfg);
    const vault = await readJson(paths.vault, []);
    const jobs = await readJson(paths.cronJobs, []);
    const conn = dbConn(cfg, 'new');
    const problems = [];

    await withDb(conn.pgUrl, async (c) => {
      for (const v of vault) {
        await ctx.checkpoint();
        const value = String(v.value ?? '').split(oldHost).join(newHost);
        try {
          const existing = (await c.query('select id from vault.secrets where name = $1', [v.name])).rows[0];
          if (existing) await c.query('select vault.update_secret($1, $2, $3, $4)', [existing.id, value, v.name, v.description || '']);
          else await c.query('select vault.create_secret($1, $2, $3)', [value, v.name, v.description || '']);
          ctx.ok(`Vault: ${v.name}${value !== v.value ? ' (address changed to the new project)' : ''}.`);
        } catch (e) {
          problems.push(`Vault ${v.name}: ${describe(e)}`);
          ctx.problem(`Vault ${v.name}: ${describe(e)}`);
        }
      }

      for (const j of jobs) {
        await ctx.checkpoint();
        const command = String(j.command).split(oldHost).join(newHost);
        try {
          if (j.jobname) {
            await c.query('select cron.schedule($1, $2, $3)', [j.jobname, j.schedule, command]);
          } else {
            const dup = (await c.query('select 1 from cron.job where schedule = $1 and command = $2', [j.schedule, command])).rowCount;
            if (!dup) await c.query('select cron.schedule($1, $2)', [j.schedule, command]);
          }
          if (j.active === false && j.jobname) {
            await c.query('select cron.alter_job(job_id := (select jobid from cron.job where jobname = $1), active := false)', [j.jobname]);
          }
          ctx.ok(`Cron: ${j.jobname || j.command.slice(0, 40)} (${j.schedule})${j.active === false ? ' — inactive, as before' : ''}.`);
        } catch (e) {
          problems.push(`Cron ${j.jobname}: ${describe(e)}`);
          ctx.problem(`Cron ${j.jobname}: ${describe(e)}`);
        }
      }
    }, ctx.signal);

    if (problems.length) {
      throw new StepError(`${problems.length} Vault secrets or cron jobs failed.`, 'Read the detail box, fix the cause, then run B7 again (it is safe to repeat).', { detail: problems.join('\n') });
    }
    return { 'Vault secrets': vault.length, 'Cron jobs': jobs.length };
  },
};
