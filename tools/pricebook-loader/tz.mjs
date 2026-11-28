// tz.mjs - imported FIRST by run.mjs. SheetJS builds cell dates in local time and the desk's parsers
// read them back with local getters, so the loader must run on UK time like the desk's browsers do,
// or a 1 Dec cell could become 30 Nov on a UTC runner. The workflow sets TZ too; this is the backstop.
if (!process.env.TZ) process.env.TZ = 'Europe/London';
