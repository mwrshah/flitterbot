#!/usr/bin/env node
import { runWhatsAppEntry } from './run-entry.js';

runWhatsAppEntry('cli', process.argv.slice(2));
