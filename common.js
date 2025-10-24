const Table = require("@saltcorn/data/models/table");
const { createDAVClient } = require("tsdav");
const ical = require("cal-parser");
const ICAL = require("ical.js");
const { findIana } = require("windows-iana");
const moment = require("moment-timezone");
const { getState } = require("@saltcorn/data/db/state");

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
      where?.start?.gt || where?.end?.gt,
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
      ([url, id]) => id == where[`${cfg.create_key_table_name}_key`],
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

const allDayDurationLegacy = (e) => {
  if (e.dtstart?.params?.value === "DATE" && e.dtend?.params?.value === "DATE")
    return true;
  if (!e.duration?.value) return false;
  return /P\d+D/.test(e.duration.value.test);
};

const getEndLegacy = (e) => {
  if (e.dtend?.value) return toUTCLegacy(e.dtend);
  if (!e.duration?.value || !e.dtstart?.value) return null;
  const d = e.duration?.value;
  const start = toUTCLegacy(e.dtstart);
  if (/PT(\d+)M/.test(d)) {
    const mins = d.match(/PT(\d+)M/)[1];
    return new Date(start.getTime() + mins * 60000);
  }
  if (/PT(\d+)H/.test(d)) {
    const hrs = d.match(/PT(\d+)H/)[1];
    return new Date(start.getTime() + hrs * 60000 * 60);
  }
};

const allDayDuration = (e) => {
  if (e.startDate?.isDate && e.endDate?.isDate) return true;
  if (!e.duration) return false;
  return /P\d+D/.test(e.duration.toString());
};

const getEnd = (e) => {
  if (e.endDate)
    return toUTC(e.endDate.toJSDate().valueOf(), e.endDate.zone.tzid);
  if (!e.duration || !e.startDate) return null;
  const d = e.duration.toString();
  const start = toUTC(e.startDate.toJSDate().valueOf(), e.startDate.zone.tzid);
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
  if (line) return line.replace("RRULE:", "").trim();
  else return null;
};

const handleObjects = async (objects, calendar, cfg) => {
  const result = [];
  for (const o of objects) {
    let component;
    try {
      component = new ICAL.Component(ICAL.parse(o.data));
    } catch (e) {
      console.error(
        "iCal parsing error on calendar",
        calendar.url,
        ":",
        e.message,
      );
      console.error("iCal data:", o.data);
      continue;
    }
    let recurrenceSet = false;

    for (const subComp of component.getAllSubcomponents("vevent")) {
      const e = new ICAL.Event(subComp);
      //console.log("e", e);
      /* if (e.summary?.value === "test eventz") {
        console.log(o.data);
        console.log(e);
      }*/
      //moment().tz("America/Los_Angeles").zoneAbbr();
      const eo = {
        url: `${o.url}${e.recurrenceId ? `#${e.recurrenceId || ""}` : ""}`,
        location: e.location,
        etag: o.etag,
        summary: e.summary,
        description: e.description,
        start: toUTC(e.startDate.toJSDate().valueOf(), e.startDate.zone.tzid),
        end: getEnd(e),
        calendar_url: calendar.url,
        categories: subComp
          .getAllProperties("categories")
          .flatMap((c) => c.getFirstValue().split(","))
          .map((s) => s.trim())
          .join(", "),
        all_day: allDayDuration(e),
        uid: e.uid,
      };
      const attendeesProps = subComp.getAllProperties("attendee");
      if (attendeesProps?.length > 0) {
        eo.attendees = attendeesProps.map((a) => {
          const email = a.getFirstValue().replace(/^mailto:/i, "");
          return {
            email,
            cn: a.getParameter("cn") || null,
            partstat: a.getParameter("partstat") || null,
            rsvp: a.getParameter("rsvp") || null,
          };
        });
      }

      if (subComp.getAllProperties("rrule").length > 0 && !recurrenceSet) {
        eo.rrule = getRRule(o.data); //e.recurrenceRule.toString();
        recurrenceSet = true;
      }
      if (cfg.create_key_field) {
        if (createKeyCache[calendar.url])
          eo[`${cfg.create_key_table_name}_key`] = createKeyCache[calendar.url];
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
      result.push(eo);
    }
  }
  return result;
};

const runQueryLegacy = async (cfg, where, opts) => {
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
            `${cfg.username}:${cfg.password}`,
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
          e.message,
        );
        console.error("iCal data:", o.data);
        continue;
      }
      let recurrenceSet = false;
      for (const e of parsed.events) {
        //console.log("e", e);
        /* if (e.summary?.value === "test eventz") {
          console.log(o.data);
          console.log(e);
        }*/
        //moment().tz("America/Los_Angeles").zoneAbbr();
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
          start: toUTCLegacy(e.dtstart),
          end: getEndLegacy(e),
          calendar_url: calendar.url,
          categories: e.categories?.value,
          all_day: allDayDurationLegacy(e),
          uid: e.uid?.value,
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

const refetchObjects = async (client, calendar, timeRange, objectUrls) => {
  const objects = await client.fetchCalendarObjects({
    calendar,
    timeRange,
    objectUrls,
    useMultiGet: true,
  });
  return objects;
};

const runQuery = async (cfg, where, opts) => {
  const result = {};
  const client = await getClient(cfg);
  const cals = await getCals(cfg, client);

  const { created, updated, deleted } = await client.syncCalendars({
    oldCalendars: cals.map((lc) => ({
      url: lc.url,
      displayName: lc.name,
      ...(opts?.syncInfos && opts.syncInfos[lc.url]
        ? opts.syncInfos[lc.url]
        : {}),
    })),
    detailedResult: true,
  });

  // handle created calendars (full sync)
  const timeRange = getTimeRange(where);
  for (const createdCal of created.filter(
    (c) => cfg[`cal_${encodeURIComponent(c.url)}`],
  )) {
    if (!(await includeCalendar(where, createdCal, cfg))) continue;
    getState().log(5, `Full sync of new CalDAV calendar ${createdCal.url}`);
    let objects;
    if (
      typeof where?.url === "string" ||
      typeof where?.url?.ilike === "string"
    ) {
      const url = (where.url?.ilike || where.url).split("#")[0];
      const resp = await fetch(url, {
        headers: new Headers({
          Authorization: `Basic ${Buffer.from(
            `${cfg.username}:${cfg.password}`,
          ).toString("base64")}`,
        }),
      });
      objects = [{ url, data: await resp.text() }];
    } else
      objects = await client.fetchCalendarObjects({
        calendar: createdCal,
        timeRange,
        useMultiGet: false,
      });
    const createdEvents = await handleObjects(objects, createdCal, cfg);
    result[createdCal.url] = {
      created: createdEvents,
      updated: [],
      deleted: [],
      syncToken: createdCal.syncToken,
      ctag: createdCal.ctag,
      fullSync: true,
    };
  }

  // handle updated calendars (incremental sync if syncToken present)
  for (const updatedCal of updated.filter(
    (c) => cfg[`cal_${encodeURIComponent(c.url)}`],
  )) {
    if (!(await includeCalendar(where, updatedCal, cfg))) continue;
    getState().log(5, `Sync of updated CalDAV calendar ${updatedCal.url}`);
    const calendarUrl = updatedCal.url;
    const isFullSync = !(
      opts?.syncInfos?.[calendarUrl] && opts.syncInfos[calendarUrl].syncToken
    );
    const oldObjects = isFullSync
      ? []
      : opts?.eventLookup && opts.eventLookup[calendarUrl]
        ? opts?.eventLookup && opts.eventLookup[calendarUrl]
        : [];
    const syncInfos = isFullSync
      ? {}
      : opts?.syncInfos && opts.syncInfos[calendarUrl]
        ? opts.syncInfos[calendarUrl]
        : {};
    result[calendarUrl] = {
      created: [],
      updated: [],
      deleted: [],
      syncToken: updatedCal.syncToken,
      ctag: updatedCal.ctag,
      fullSync: isFullSync,
    };

    const {
      created: createdObjects,
      updated: updatedObjects,
      deleted: deletedObjects,
    } = (
      await client.smartCollectionSync({
        collection: {
          url: calendarUrl,
          ...syncInfos,
          objects: oldObjects,
          objectMultiGet: client.calendarMultiGet,
        },
        method: "webdav",
        detailedResult: true,
      })
    ).objects;

    getState().log(
      5,
      `SmartCollectionSync of ${calendarUrl}: ${createdObjects.length} created, ${updatedObjects.length} updated, ${deletedObjects.length} deleted`,
    );
    if (createdObjects.length > 0) {
      const refetched = await refetchObjects(
        client,
        updatedCal,
        timeRange,
        createdObjects.map((o) => o.url),
      );
      result[calendarUrl].created = await handleObjects(
        // refetch for full eventUrls (not only pathname)
        refetched,
        updatedCal,
        cfg,
      );
    }

    if (updatedObjects.length > 0) {
      // refetch for full eventUrls (not only pathname)
      const refetched = await refetchObjects(
        client,
        updatedCal,
        timeRange,
        updatedObjects.map((o) => o.url),
      );
      result[calendarUrl].updated = await handleObjects(
        refetched,
        updatedCal,
        cfg,
      );
    }

    if (deletedObjects.length > 0) {
      // refetch for full eventUrls (not only pathname)
      const refetched = await refetchObjects(
        client,
        updatedCal,
        timeRange,
        deletedObjects.map((o) => o.url),
      );
      result[calendarUrl].deleted = refetched.map((o) => ({
        url: o.url,
        calendar_url: calendarUrl,
      }));
    }
  }

  // handle deleted calendars
  for (const deletedCal of deleted.filter(
    (c) => cfg[`cal_${encodeURIComponent(c.url)}`],
  )) {
    if (!(await includeCalendar(where, deletedCal, cfg))) continue;
    const calendarUrl = deletedCal.url;
    getState().log(5, `CalDAV calendar deleted ${calendarUrl}`);
    if (opts?.eventLookup && opts.eventLookup[calendarUrl]) {
      const calEvents = opts.eventLookup[calendarUrl];
      result[calendarUrl].deleted = calEvents.map((e) => ({
        url: e.url,
        etag: e.etag,
        calendar_url: calendarUrl,
      }));
    }
  }

  return result;
};

const toUTC = (value, tzid) => {
  if (!value) return null;
  if (!tzid) return new Date(value);
  //const tzAbbrev = moment().tz("America/Los_Angeles").zoneAbbr();
  const dlocal = new Date(value);
  const ianaTz = findIana(tzid);
  const d = moment
    .tz(
      dlocal.toISOString().split("Z")[0],
      ianaTz.length > 0 ? ianaTz[0] : "UTC",
    )
    .format(); // CST
  return new Date(d);
};

const toUTCLegacy = ({ value, params } = {}) => {
  if (!value) return null;
  if (!params?.tzid) return new Date(value);
  //const tzAbbrev = moment().tz("America/Los_Angeles").zoneAbbr();
  const dlocal = new Date(value);
  const d = moment
    .tz(dlocal.toISOString().split("Z")[0], params?.tzid)
    .format(); // CST
  return new Date(d);
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
  runQueryLegacy,
};
