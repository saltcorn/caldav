const db = require("@saltcorn/data/db");
const Table = require("@saltcorn/data/models/table");
const File = require("@saltcorn/data/models/file");
const User = require("@saltcorn/data/models/user");
const Crash = require("@saltcorn/data/models/crash");
const Trigger = require("@saltcorn/data/models/trigger");
const Plugin = require("@saltcorn/data/models/plugin");
const { getState } = require("@saltcorn/data/db/state");
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

const objMap = (obj, f) => {
  const result = {};
  Object.keys(obj).forEach((k) => {
    result[k] = f(obj[k]);
  });
  return result;
};

const getExistingEtags = async (
  table,
  { etag_field, url_field, calendar_url_field }
) => {
  const existing = await table.getRows({});
  const existingETags = new Set(
    existing.map(
      (e) =>
        // we need all three because we want duplication of events with multiple participants
        e[calendar_url_field] + "///" + e[url_field] + "///" + e[etag_field]
    )
  );
  return existingETags;
};

module.exports = (cfg) => ({
  configFields: async () => {
    const tables = await Table.find();
    const tableMap = {};
    tables.forEach((t) => (tableMap[t.name] = t));

    const strOptFields = objMap(tableMap, (table) => [
      "",
      ...table.fields
        .filter((f) => f.type?.name === "String")
        .map((f) => f.name),
    ]);
    const strFields = objMap(tableMap, (table) =>
      table.fields.filter((f) => f.type?.name === "String").map((f) => f.name)
    );

    const dateFields = objMap(tableMap, (table) =>
      table.fields.filter((f) => f.type?.name === "Date").map((f) => f.name)
    );
    const boolFields = objMap(tableMap, (table) =>
      table.fields.filter((f) => f.type?.name === "Bool").map((f) => f.name)
    );
    const triggers = await Trigger.find({});
    const client = await getClient(cfg);
    const cals = await getCals(cfg, client);

    return [
      ...cals.map((c) => ({
        name: `cal_${encodeURIComponent(c.url)}`,
        label: c.displayName,
        sublabel: c.url,
        type: "Bool",
      })),
      {
        name: "table_dest",
        label: "Destination table",
        sublabel: "Table to sync to",
        input_type: "select",
        required: true,
        options: tables.map((t) => t.name),
      },
      {
        name: "url_field",
        label: "Event URL field",
        type: "String",
        required: true,
        attributes: {
          calcOptions: ["table_dest", strFields],
        },
      },
      {
        name: "uid_field",
        label: "UID field",
        type: "String",
        required: true,
        attributes: {
          calcOptions: ["table_dest", strFields],
        },
      },
      {
        name: "summary_field",
        label: "Summary field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", strFields],
        },
      },
      {
        name: "start_field",
        label: "Start field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", dateFields],
        },
      },
      {
        name: "end_field",
        label: "End field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", dateFields],
        },
      },

      {
        name: "location_field",
        label: "Location field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", strOptFields],
        },
      },
      {
        name: "calendar_url_field",
        label: "Calendar URL field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", strOptFields],
        },
      },
      {
        name: "description_field",
        label: "Description field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", strOptFields],
        },
      },
      {
        name: "categories_field",
        label: "Categories field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", strOptFields],
        },
      },
      {
        name: "etag_field",
        label: "E-Tag field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", strFields],
        },
      },
      {
        name: "rrule_field",
        label: "Recurrence rule field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", strOptFields],
        },
      },
      {
        name: "all_day_field",
        label: "All day field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", boolFields],
        },
      },
      {
        name: "error_action",
        label: "Error action",
        sublabel: "Run this action when there is an error processing calendars",
        type: "String",
        attributes: {
          options: triggers.map((tr) => tr.name),
        },
      },
    ];
  },
  disableInBuilder: true,
  disableInList: true,

  run: async ({ row, configuration, req }) => {
    const {
      table_dest,
      url_field,
      summary_field,
      start_field,
      end_field,
      location_field,
      calendar_url_field,
      description_field,
      categories_field,
      all_day_field,
      etag_field,
      rrule_field,
      error_action,
      uid_field,
      ...calFlags
    } = configuration;

    const table = await Table.findOne({ name: table_dest });
    const existingETags = await getExistingEtags(table, configuration);
    const all_events = await runQuery({ ...calFlags, ...cfg }, {}, {});
    const deleteEtags = new Set(existingETags);
    for (const e of all_events) {
      const tag =
        e[calendar_url_field] + "///" + e[url_field] + "///" + e[etag_field];
      deleteEtags.delete(tag);
      if (existingETags.has(tag)) continue;
      // insert or update
      const row = {
        [url_field]: e.url,
        [summary_field]: e.summary,
        [start_field]: e.start,
        [end_field]: e.end,
        [location_field]: e.location,
        [description_field]: e.description,
        [categories_field]: e.categories,
        [calendar_url_field]: e.calendar_url,
        [etag_field]: e.etag,
        [all_day_field]: e.all_day,
      };
      if (rrule_field) row[rrule_field] = e.rrule;
      if (uid_field) row[uid_field] = e.uid;
      const existingEvent = await table.getRow({ [url_field]: e.url });
      if (existingEvent) {
        if (
          Object.keys(row).filter(
            (k) => row[k] !== existingEvent[table.pk_name]
          ).length
        )
          await table.updateRow(row, existingEvent[table.pk_name]);
      } else await table.insertRow(row);
    }
    for (const delTag of [...deleteEtags]) {
      const [cal_url, del_url, del_etag] = delTag.split("///");
      await table.deleteRows({
        [calendar_url_field]: cal_url,
        [etag_field]: del_etag,
        [url_field]: del_url,
      });
    }
  },
});
