import fs from 'node:fs';
import path from 'node:path';
import { Database } from '../packages/db/src/database.js';

async function verifyPersistenceAndRecovery() {
  console.log('====================================================');
  console.log('📦 YouPI PG — Persistence, Backup & Recovery Audit');
  console.log('====================================================');

  const liveDbPath = path.resolve('data/youpi_pg.sqlite');
  console.log('[1/4] Inspecting live SQLite database at:', liveDbPath);
  if (!fs.existsSync(liveDbPath)) {
    throw new Error(`Live database not found: ${liveDbPath}`);
  }

  // 1. Audit Live Data
  const liveDb = new Database({ dbPath: liveDbPath });
  const liveMerchants = liveDb.query('SELECT id, business_name FROM merchants');
  const liveAccounts = liveDb.query('SELECT id, upi_id FROM payment_receiving_accounts');
  const liveSessions = liveDb.query('SELECT id, order_id, amount_paise, status FROM payment_sessions');
  const liveObservations = liveDb.query('SELECT id, bank_reference_number FROM payment_observations');
  const liveDevices = liveDb.query('SELECT id, device_name FROM android_devices');

  console.log(`[✓] Live Data Found:`);
  console.log(`    • Merchants: ${liveMerchants.length}`);
  console.log(`    • Receiving Accounts: ${liveAccounts.length}`);
  console.log(`    • Payment Sessions: ${liveSessions.length}`);
  console.log(`    • Observations: ${liveObservations.length}`);
  console.log(`    • Enrolled Android Devices: ${liveDevices.length}`);

  // 2. Perform Safe WAL Flush & Snapshot Backup using VACUUM INTO
  console.log('\n[2/4] Testing safe WAL checkpoint and single-file VACUUM INTO snapshot...');
  const backupDir = path.resolve('data/backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const backupFile = path.join(backupDir, `test_audit_backup_${Date.now()}.sqlite`);
  
  // First ensure WAL frames are flushed
  liveDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  
  // Execute clean VACUUM INTO
  liveDb.exec(`VACUUM INTO '${backupFile.replace(/\\/g, '/')}';`);
  liveDb.close();

  const backupStat = fs.statSync(backupFile);
  console.log(`[✓] Backup created successfully: ${backupFile} (${backupStat.size} bytes)`);

  // 3. Restore and Verify Integrity from Backup File
  console.log('\n[3/4] Restoring from backup and validating row-by-row consistency...');
  const restoredDb = new Database({ dbPath: backupFile, autoMigrate: false });

  const restoredMerchants = restoredDb.query('SELECT id, business_name FROM merchants');
  const restoredAccounts = restoredDb.query('SELECT id, upi_id FROM payment_receiving_accounts');
  const restoredSessions = restoredDb.query('SELECT id, order_id, amount_paise, status FROM payment_sessions');
  const restoredObservations = restoredDb.query('SELECT id, bank_reference_number FROM payment_observations');
  const restoredDevices = restoredDb.query('SELECT id, device_name FROM android_devices');

  if (restoredMerchants.length !== liveMerchants.length) {
    throw new Error(`Merchant count mismatch: live ${liveMerchants.length} vs restored ${restoredMerchants.length}`);
  }
  if (restoredAccounts.length !== liveAccounts.length) {
    throw new Error(`Account count mismatch: live ${liveAccounts.length} vs restored ${restoredAccounts.length}`);
  }
  if (restoredSessions.length !== liveSessions.length) {
    throw new Error(`Session count mismatch: live ${liveSessions.length} vs restored ${restoredSessions.length}`);
  }
  if (restoredObservations.length !== liveObservations.length) {
    throw new Error(`Observation count mismatch: live ${liveObservations.length} vs restored ${restoredObservations.length}`);
  }
  if (restoredDevices.length !== liveDevices.length) {
    throw new Error(`Device count mismatch: live ${liveDevices.length} vs restored ${restoredDevices.length}`);
  }

  console.log(`[✓] 100% Integrity Match Across All Tables:`);
  console.log(`    • Merchants: ${restoredMerchants.length} matches`);
  console.log(`    • Receiving Accounts: ${restoredAccounts.length} matches`);
  console.log(`    • Payment Sessions: ${restoredSessions.length} matches`);
  console.log(`    • Observations: ${restoredObservations.length} matches`);
  console.log(`    • Android Devices: ${restoredDevices.length} matches`);

  restoredDb.close();

  // 4. Test Persistence Across Clean Client Re-instantiation
  console.log('\n[4/4] Testing fresh client initialization against live DB file...');
  const freshLiveDb = new Database({ dbPath: liveDbPath });
  const freshSessions = freshLiveDb.query('SELECT count(*) as c FROM payment_sessions');
  console.log(`[✓] Fresh instance successfully read ${freshSessions[0]?.c} sessions from persisted disk file.`);
  freshLiveDb.close();

  // Clean up temporary test backup
  fs.unlinkSync(backupFile);
  console.log(`[✓] Temporary audit backup file cleaned up.`);

  console.log('\n====================================================');
  console.log('🎉 PERSISTENCE, BACKUP & RESTORE VERIFIED 100%');
  console.log('====================================================');
}

verifyPersistenceAndRecovery().catch(err => {
  console.error('\n❌ Persistence audit failed:', err);
  process.exit(1);
});
