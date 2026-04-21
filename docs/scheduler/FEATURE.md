# Cron Scheduler

An OS-level timer that pings the running control surface for periodic proactive behavior (checking stale sessions, reviewing Todoist, surfacing suggestions). It is health-gated: if the control surface is down or unhealthy, nothing happens — cron never starts processes or enqueues prompts on its own.
