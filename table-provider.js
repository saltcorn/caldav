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
        name: "query",
        form: async () => {
          const client = await getClient(cfg);
          const cals = await getCals(cfg, client);
          return new Form({
            fields: [
              {
                name: "calendar_url",
                label: "Calendar URL",
                type: "String",
                required: true,
                attributes: { options: cals.map((c) => c.url) },
              },
            ],
          });
        },
      },
    ],
  });

let _allCals;

const getClient = async ({ username, password, auth_method, url }) => {
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
  _allCals = calendars;
  return calendars;
};

const runQuery = async (cfg, where, opts) => {
  const client = await getClient(cfg);
  const cals = await getCals(cfg, client);
  const calendar = cals.find((c) => c.url === cfg.calendar_url);
  console.log("calendar", calendar);

  const objects = await client.fetchCalendarObjects({
    calendar,
  });

  console.log(objects[0]);
  const parsed = ical.parseString(objects[0].data);
  console.log("parsed", JSON.stringify(parsed, null, 2));
  const evs = objects.map((o) => {
    const parsed = ical.parseString(o.data);
    return parsed.events.map((e) => ({
      uid: e.uid?.value,
      location: e.location?.value,
      summary: e.summary?.value,
      start: e.dtstart?.value ? new Date(e.dtstart?.value) : null,
      end: e.dtend?.value ? new Date(e.dtend?.value) : null,
    }));
  });
  return evs.flat(1);
};

module.exports = (cfg) => ({
  CalDav: {
    configuration_workflow: configuration_workflow(cfg),
    fields: (cfg) => [
      { name: "uid", type: "String", label: "UID", primary_key: true },
      { name: "summary", label: "Summary", type: "String" },
      { name: "location", label: "Location", type: "String" },
      { name: "start", label: "Start", type: "Date" },
      { name: "end", label: "End", type: "Date" },
    ],
    get_table: (cfgTable) => {
      return {
        getRows: async (where, opts) => {
          const qres = await runQuery({ ...cfg, ...cfgTable }, where, opts);
          return qres;
        },
      };
    },
  },
});
