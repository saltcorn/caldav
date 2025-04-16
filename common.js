const Table = require("@saltcorn/data/models/table");
const { createDAVClient } = require("tsdav");
const ical = require("cal-parser");

let _allCals;

const getClient = async ({ username, password, auth_method, url }) => {
  //console.log({ url });

  const client = await createDAVClient({
    serverUrl: url,
    credentials: {
      username,
      password,
    },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  return client;
};

const getCals = async (opts, client0) => {
  if (_allCals) return _allCals;
  const client = client0 || (await getClient(opts));
  const calendars = await client.fetchCalendars();
  _allCals = calendars.filter((c) => c.ctag !== -1);
  return _allCals;
};

const getTimeRange = (where) => {
  let timeRange;
  if (where?.start?.gt || where?.end?.gt) {
    timeRange = {};
    timeRange.start = new Date(
      where?.start?.gt || where?.end?.gt
    ).toISOString();
  }
  if (where?.start?.lt || where?.end?.lt) {
    if (!timeRange) timeRange = {};
    timeRange.end = new Date(where?.start?.lt || where?.end?.lt).toISOString();
  }
  return timeRange;
};

const includeCalendar = async (where, calendar, cfg) => {
  if (typeof where?.url === "string" || typeof where?.url?.ilike === "string") {
    return (where.url?.ilike || where.url).startsWith(calendar.url);
  }
  if (
    typeof where?.calendar_url === "string" &&
    where?.calendar_url !== calendar.url
  )
    return false;
  if (where?.calendar_url?.in && !where?.calendar_url.in.includes(calendar.url))
    return false;
  if (cfg?.create_key_field && where[`${cfg.create_key_table_name}_key`]) {
    const cacheVal = Object.entries(createKeyCache).find(
      ([url, id]) => id == where[`${cfg.create_key_table_name}_key`]
    );
    if (cacheVal) return cacheVal[0] === calendar.url;

    const table = Table.findOne(cfg.create_key_table_name);
    const row = await table.getRow({
      [cfg.create_key_field_name]: calendar.url,
    });
    if (row) {
      createKeyCache[calendar.url] = row[table.pk_name];
      return row[table.pk_name] == calendar.url;
    }
    return false;
  }
  return true;
};

const allDayDuration = (e) => {
  if (e.dtstart?.params?.value === "DATE" && e.dtend?.params?.value === "DATE")
    return true;
  if (!e.duration?.value) return false;
  return /P\d+D/.test(e.duration.value.test);
};

const getEnd = (e) => {
  if (e.dtend?.value) return new Date(e.dtend?.value);
  if (!e.duration?.value || !e.dtstart?.value) return null;
  const d = e.duration?.value;
  const start = new Date(e.dtstart?.value);
  if (/PT(\d+)M/.test(d)) {
    const mins = d.match(/PT(\d+)M/)[1];
    return new Date(start.getTime() + mins * 60000);
  }
  if (/PT(\d+)H/.test(d)) {
    const hrs = d.match(/PT(\d+)H/)[1];
    return new Date(start.getTime() + hrs * 60000 * 60);
  }
};

const createKeyCache = {};

const getRRule = (odata) => {
  const tzSplit = odata.split("END:VTIMEZONE");
  const afterTz = tzSplit[tzSplit.length - 1];
  const lines = afterTz.split("\n");
  const line = lines.find((l) => l.startsWith("RRULE:"));
  if (line) return line.replace("RRULE:", "");
  else return null;
};

const runQuery = async (cfg, where, opts) => {
  //console.log("caldav where", where);
  //console.log("caldav cfg", cfg);

  const client = await getClient(cfg);
  const cals = await getCals(cfg, client);
  const calendars = cals.filter((c) => cfg[`cal_${encodeURIComponent(c.url)}`]);
  const all_evs = [];
  for (const calendar of calendars) {
    if (!(await includeCalendar(where, calendar, cfg))) continue;

    let timeRange = getTimeRange(where);

    let objects;
    if (
      typeof where?.url === "string" ||
      typeof where?.url?.ilike === "string"
    ) {
      const url = (where.url?.ilike || where.url).split("#")[0];
      const resp = await fetch(url, {
        headers: new Headers({
          Authorization: `Basic ${Buffer.from(
            `${cfg.username}:${cfg.password}`
          ).toString("base64")}`,
        }),
      });
      //console.log("resp", await resp.text());
      objects = [{ url, data: await resp.text() }];
    } else
      objects = await client.fetchCalendarObjects({
        calendar,
        timeRange,
        useMultiGet: false,
      });

    //const parsed = ical.parseString(objects[0].data);
    //console.log("parsed", JSON.stringify(parsed, null, 2));
    for (const o of objects) {
      let parsed;
      try {
        parsed = ical.parseString(o.data);
      } catch (e) {
        console.error(
          "iCal parsing error on calendar",
          calendar.url,
          ":",
          e.message
        );
        console.error("iCal data:", o.data);
        continue;
      }
      let recurrenceSet = false;
      for (const e of parsed.events) {
        //console.log("e", e);

        const eo = {
          url: `${o.url}${
            e["recurrence-id"]?.value
              ? `#${e["recurrence-id"].value || ""}`
              : ""
          }`,
          location: e.location?.value,
          etag: o.etag,
          summary: e.summary?.value,
          description: e.description?.value,
          start: e.dtstart?.value ? new Date(e.dtstart?.value) : null,
          end: getEnd(e),
          calendar_url: calendar.url,
          categories: e.categories?.value,
          all_day: allDayDuration(e),
        };
        if (e.recurrenceRule && !recurrenceSet) {
          eo.rrule = getRRule(o.data); //e.recurrenceRule.toString();
          recurrenceSet = true;
        }
        if (cfg.create_key_field) {
          if (createKeyCache[calendar.url])
            eo[`${cfg.create_key_table_name}_key`] =
              createKeyCache[calendar.url];
          else {
            const table = Table.findOne(cfg.create_key_table_name);
            const row = await table.getRow({
              [cfg.create_key_field_name]: calendar.url,
            });
            if (row) {
              const id = row[table.pk_name];
              eo[`${cfg.create_key_table_name}_key`] = id;
              createKeyCache[calendar.url] = id;
            }
          }
        }
        all_evs.push(eo);
      }
    }
  }
  return all_evs;
};

module.exports = {
  createKeyCache,
  getClient,
  getCals,
  getEnd,
  allDayDuration,
  includeCalendar,
  getTimeRange,
  runQuery,
};
