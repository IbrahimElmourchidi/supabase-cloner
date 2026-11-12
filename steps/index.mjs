import a0 from './a0_check_old.mjs';
import a1 from './a1_dump_db.mjs';
import a2 from './a2_storage_download.mjs';
import a3 from './a3_config_backup.mjs';
import a4 from './a4_check_backup.mjs';
import b0 from './b0_check_new.mjs';
import b1 from './b1_extensions.mjs';
import b2 from './b2_restore_db.mjs';
import b3 from './b3_storage_upload.mjs';
import b4 from './b4_fix_links.mjs';
import b5 from './b5_functions.mjs';
import b6 from './b6_settings.mjs';
import b7 from './b7_vault_cron.mjs';
import b8 from './b8_verify.mjs';

export const STEPS = [a0, a1, a2, a3, a4, b0, b1, b2, b3, b4, b5, b6, b7, b8];
export const stepById = (id) => STEPS.find((s) => s.id === id);
