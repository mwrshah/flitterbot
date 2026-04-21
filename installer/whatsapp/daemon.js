#!/usr/bin/env node
import { runWhatsAppEntry } from './run-entry.js';

runWhatsAppEntry('daemon', process.argv.slice(2));
