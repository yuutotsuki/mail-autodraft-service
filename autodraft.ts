import { initializeEnvironment } from './config/environment';
import { initDb } from './db/sqlite';
import { startAutoDraftWorker } from './services/autoDraftService';

initializeEnvironment();
initDb();
startAutoDraftWorker();

console.log('✉️ Mail Autodraft Service is running');
