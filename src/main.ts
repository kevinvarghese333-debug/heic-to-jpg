import './styles.css';
import { installNetGuard } from './lib/netGuard';

// Installed before any application code runs, so the byte counter in the header
// observes every outbound call the page could possibly make.
installNetGuard();

import('./ui');
