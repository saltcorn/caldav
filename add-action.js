const db = require("@saltcorn/data/db");
const Table = require("@saltcorn/data/models/table");
const File = require("@saltcorn/data/models/file");
const User = require("@saltcorn/data/models/user");
const Crash = require("@saltcorn/data/models/crash");
const Trigger = require("@saltcorn/data/models/trigger");
const Plugin = require("@saltcorn/data/models/plugin");
const { getState } = require("@saltcorn/data/db/state");
const { eval_expression } = require("@saltcorn/data/models/expression");

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

module.exports = (cfg) => ({
  requireRow: true,
  configFields: async ({ table }) => {
    const strOptFields = table.fields
      .filter((f) => f.type?.name === "String")
      .map((f) => f.name);

    const strFields = table.fields
      .filter((f) => f.type?.name === "String")
      .map((f) => f.name);

    const dateFields = table.fields
      .filter((f) => f.type?.name === "Date")
      .map((f) => f.name);

    const boolFields = table.fields
      .filter((f) => f.type?.name === "Bool")
      .map((f) => f.name);

    const triggers = await Trigger.find({});
    const client = await getClient(cfg);

    return [
      {
        name: "summary_field",
        label: "Summary field",
        type: "String",
        attributes: {
          options: strFields,
        },
      },
      {
        name: "start_field",
        label: "Start field",
        type: "String",
        attributes: {
          options: dateFields,
        },
      },
      {
        name: "end_field",
        label: "End field",
        type: "String",
        attributes: {
          options: dateFields,
        },
      },

      {
        name: "location_field",
        label: "Location field",
        type: "String",
        attributes: {
          options: strOptFields,
        },
      },
      {
        name: "calendar_url_field",
        label: "Calendar URL field",
        type: "String",
        attributes: {
          options: strOptFields,
        },
      },
      {
        name: "description_field",
        label: "Description field",
        type: "String",
        attributes: {
          options: strOptFields,
        },
      },
      {
        name: "categories_field",
        label: "Categories field",
        type: "String",
        attributes: {
          options: strOptFields,
        },
      },
      {
        name: "rrule_field",
        label: "Recurrence rule field",
        type: "String",
        attributes: {
          options: strOptFields,
        },
      },
      {
        name: "only_if",
        label: "Only if",
        type: "String",
      },
      {
        name: "all_day_field",
        label: "All day field",
        type: "String",
        attributes: {
          options: boolFields,
        },
      },
    ];
  },

  run: async ({ table, row, configuration, req, user }) => {
    const {
      summary_field,
      start_field,
      end_field,
      location_field,
      calendar_url_field,
      description_field,
      categories_field,
      all_day_field,
      rrule_field,
      error_action,
      only_if,
    } = configuration;
    const goahead = only_if
      ? eval_expression(only_if, row || {}, user, "caldav_add only_if")
      : true;
    if (!goahead) return;
    console.log("inserting in caldav", row);

    const client = await getClient(cfg);
    const calendars = await getCals(cfg, client);
    const cal = calendars.find((c) => c.url === row[calendar_url_field]);
    if (!cal) return { error: "Calendar not found" };
    const id = row[table.pk_name] || new Date().toISOString();
    const filename = `event${id}.ics`;
    const date_to_str = (d) =>
      d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

    const evAttrs = {
      dtstamp: date_to_str(new Date()),
      dtstart: date_to_str(row[start_field]),
      dtend: date_to_str(row[end_field]),
      summary: row[summary_field],
      description: row[description_field],
      location: row[location_field],
      uid: id,
    };
    if (row[rrule_field]) evAttrs.rrule = row[rrule_field];
    const iCalString = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Saltcorn//EN
CALSCALE:GREGORIAN
METHOD:REQUEST
BEGIN:VEVENT
${Object.entries(evAttrs)
  .map(([k, v]) => `${k.toUpperCase()}:${v}`)
  .join("\n")}
END:VEVENT
END:VCALENDAR`;
    const result = await client.createCalendarObject({
      calendar: calendars[0],
      filename,
      iCalString,
    });
    console.log(
      "caldav insert status",
      result.status,
      "response: ",
      await result.text()
    );
  },
});
