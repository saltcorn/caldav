const db = require("@saltcorn/data/db");
const { eval_expression } = require("@saltcorn/data/models/expression");
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const Field = require("@saltcorn/data/models/field");
const Table = require("@saltcorn/data/models/table");
const { getState } = require("@saltcorn/data/db/state");
const { mkTable } = require("@saltcorn/markup");
const { pre, code } = require("@saltcorn/markup/tags");
const { createDAVClient } = require("tsdav");
const ical = require("cal-parser");
const configuration_workflow = (cfg) => (req) =>
  new Workflow({
    steps: [
      {
        name: "Calendars",
        form: async () => {
          const client = await getClient(cfg);
          const cals = await getCals(cfg, client);
          return new Form({
            blurb: "Subscribed calendars to pull events from",
            fields: cals.map((c) => ({
              name: `cal_${encodeURIComponent(c.url)}`,
              label: c.displayName,
              sublabel: c.url,
              type: "Bool",
            })),
          });
        },
      },
      {
        name: "Create Keys",
        form: async () => {
          const tables = await Table.find({});
          const field_options = {};
          tables.forEach((t) => {
            field_options[t.name] = t.fields
              .filter((f) => f.type?.name === "String")
              .map((f) => f.name);
          });

          return new Form({
            blurb:
              "Create key field by matching calendar URL to field in a different table",
            fields: [
              {
                label: "Create key field",
                name: "create_key_field",
                type: "Bool",
              },
              {
                name: "create_key_table_name",
                label: "Table",
                type: "String",
                required: true,
                attributes: { options: tables.map((t) => t.name) },
                showIf: { create_key_field: true },
              },
              {
                name: "create_key_field_name",
                label: "Field",
                type: "String",
                required: true,
                attributes: {
                  calcOptions: ["create_key_table_name", field_options],
                },
                showIf: { create_key_field: true },
              },
            ],
          });
        },
      },
    ],
  });

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

const runQuery = async (cfg, where, opts) => {
  const client = await getClient(cfg);
  const cals = await getCals(cfg, client);
  const calendars = cals.filter((c) => cfg[`cal_${encodeURIComponent(c.url)}`]);
  const all_evs = [];
  for (const calendar of calendars) {
    if (!includeCalendar(where, calendar, cfg)) continue;

    let timeRange = getTimeRange(where);

    const objects = await client.fetchCalendarObjects({
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

      for (const e of parsed.events) {
        //console.log("e", e);

        const eo = {
          uid: e.uid?.value,
          location: e.location?.value,
          summary: e.summary?.value,
          description: e.description?.value,
          start: e.dtstart?.value ? new Date(e.dtstart?.value) : null,
          end: getEnd(e),
          calendar_url: calendar.url,
          categories: e.categories?.value,
          all_day: allDayDuration(e),
        };
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

const includeCalendar = (where, calendar, cfg) => {
  if (
    typeof where?.calendar_url === "string" &&
    where?.calendar_url !== calendar.url
  )
    return false;
  if (where?.calendar_url?.in && !where?.calendar_url.in.includes(calendar.url))
    return false;

  return true;
};

const countEvents = async (cfg, where, opts) => {
  if (Object.keys(where).length === 0) return null;
  const client = await getClient(cfg);
  const cals = await getCals(cfg, client);
  const calendars = cals.filter((c) => cfg[`cal_${encodeURIComponent(c.url)}`]);
  const all_evs = [];
  let eventCount = 0;
  for (const calendar of calendars) {
    if (!includeCalendar(where, calendar, cfg)) continue;
    const timeRange = getTimeRange(where);
    const objects = await client.fetchCalendarObjects({
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

      //console.log("e", e);

      for (const e of parsed.events) eventCount += 1;
    }
  }

  return eventCount;
};

const allDayDuration = (e) => {
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

module.exports = (cfg) => ({
  CalDav: {
    configuration_workflow: configuration_workflow(cfg),
    fields: (cfg) => [
      { name: "uid", type: "String", label: "UID", primary_key: true },
      { name: "summary", label: "Summary", type: "String" },
      { name: "start", label: "Start", type: "Date" },
      { name: "end", label: "End", type: "Date" },
      { name: "description", label: "Description", type: "String" },
      { name: "location", label: "Location", type: "String" },
      { name: "calendar_url", label: "Calendar URL", type: "String" },
      { name: "description", label: "Description", type: "String" },
      { name: "categories", label: "Categories", type: "String" },
      { name: "all_day", label: "All day", type: "Bool" },
      ...(cfg?.create_key_field
        ? [
            {
              name: `${cfg.create_key_table_name}_key`,
              label: `${cfg.create_key_table_name} key`,
              type: `Key to ${cfg.create_key_table_name}`,
            },
          ]
        : []),
    ],
    get_table: (cfgTable) => {
      return {
        getRows: async (where, opts) => {
          const qres = await runQuery({ ...cfg, ...cfgTable }, where, opts);
          return qres;
        },
        countRows: async (where, opts) => {
          return await countEvents({ ...cfg, ...cfgTable }, where, opts);
        },
      };
    },
  },
});
