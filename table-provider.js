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
const fetch = require("node-fetch");

const {
  getClient,
  getCals,
  getEnd,
  allDayDuration,
  includeCalendar,
  getTimeRange,
  createKeyCache,
  runQuery,
} = require("./common");

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

const countEvents = async (cfg, where, opts) => {
  if (Object.keys(where || {}).length === 0) return null;
  const client = await getClient(cfg);
  const cals = await getCals(cfg, client);
  const calendars = cals.filter((c) => cfg[`cal_${encodeURIComponent(c.url)}`]);
  const all_evs = [];
  let eventCount = 0;
  for (const calendar of calendars) {
    if (!(await includeCalendar(where, calendar, cfg))) continue;
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

module.exports = (cfg) => ({
  CalDav: {
    configuration_workflow: configuration_workflow(cfg),
    fields: (cfg) => [
      { name: "url", type: "String", label: "URL", primary_key: true },
      { name: "summary", label: "Summary", type: "String" },
      { name: "start", label: "Start", type: "Date" },
      { name: "end", label: "End", type: "Date" },
      { name: "location", label: "Location", type: "String" },
      { name: "calendar_url", label: "Calendar URL", type: "String" },
      { name: "description", label: "Description", type: "String" },
      { name: "categories", label: "Categories", type: "String" },
      { name: "etag", label: "E-Tag", type: "String" },
      { name: "rrule", label: "RRule", type: "String" },

      { name: "all_day", label: "All day", type: "Bool" },
      ...(cfg?.create_key_field
        ? [
            {
              name: `${cfg.create_key_table_name}_key`,
              label: `${cfg.create_key_table_name} key`,
              type: `Key to ${cfg.create_key_table_name}`,
              attributes:
                cfg.create_key_table_name === "users"
                  ? { summary_field: "email" }
                  : {},
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
