import { useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Minus, Plus } from "lucide-react";
import { t } from "@/utils/i18n";

type CalendarMotion = "next" | "prev" | "zoomIn";

interface PublicationDateTimePickerProps {
  value: string;
  minimumDate: Date;
  lang: "zh" | "en";
  disabled?: boolean;
  onChange: (value: string) => void;
}

const pad = (value: number) => String(value).padStart(2, "0");

function formatLocalDateTime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseLocalDateTime(value: string): Date | null {
  const [datePart, timePart] = value.split("T");
  if (!datePart || !timePart) return null;
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  if (
    !year || !month || !day
    || hour === undefined || minute === undefined
    || hour < 0 || hour > 23 || minute < 0 || minute > 59
  ) return null;
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) return null;
  return date;
}

function ceilToMinute(date: Date): Date {
  const rounded = new Date(date);
  if (rounded.getSeconds() > 0 || rounded.getMilliseconds() > 0) rounded.setMinutes(rounded.getMinutes() + 1);
  rounded.setSeconds(0, 0);
  return rounded;
}

function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function dateValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function calendarDays(month: Date) {
  const firstDay = monthStart(month);
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  const startDate = new Date(firstDay);
  startDate.setDate(firstDay.getDate() - mondayOffset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + index);
    return {
      date,
      value: dateValue(date),
      isCurrentMonth: date.getMonth() === month.getMonth(),
    };
  });
}

function endOfDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

function clampToMinimum(date: Date, minimumDate: Date): Date {
  return date.getTime() < minimumDate.getTime() ? new Date(minimumDate) : date;
}

export default function PublicationDateTimePicker({
  value,
  minimumDate,
  lang,
  disabled = false,
  onChange,
}: PublicationDateTimePickerProps) {
  const minimumTimestamp = minimumDate.getTime();
  const minimum = useMemo(() => ceilToMinute(minimumDate), [minimumTimestamp]);
  const parsedValue = useMemo(() => parseLocalDateTime(value), [value]);
  const selectedDate = parsedValue ?? minimum;
  const selectedTimestamp = selectedDate.getTime();
  const [displayMonth, setDisplayMonth] = useState(() => monthStart(selectedDate));
  const [motion, setMotion] = useState<CalendarMotion>("zoomIn");
  const [hourDraft, setHourDraft] = useState(() => pad(selectedDate.getHours()));
  const [minuteDraft, setMinuteDraft] = useState(() => pad(selectedDate.getMinutes()));

  useEffect(() => {
    setHourDraft(pad(selectedDate.getHours()));
    setMinuteDraft(pad(selectedDate.getMinutes()));
  }, [selectedTimestamp]);

  useEffect(() => {
    if (!parsedValue) return;
    setDisplayMonth((current) => (
      current.getFullYear() === parsedValue.getFullYear() && current.getMonth() === parsedValue.getMonth()
        ? current
        : monthStart(parsedValue)
    ));
  }, [parsedValue?.getFullYear(), parsedValue?.getMonth()]);

  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const todayValue = dateValue(new Date());
  const selectedValue = dateValue(selectedDate);
  const earliestMonth = monthStart(minimum);
  const canMovePrevious = displayMonth.getTime() > earliestMonth.getTime();
  const days = calendarDays(displayMonth);
  const weekdays = lang === "zh"
    ? ["一", "二", "三", "四", "五", "六", "日"]
    : ["M", "T", "W", "T", "F", "S", "S"];

  const emitDate = (nextDate: Date) => onChange(formatLocalDateTime(clampToMinimum(nextDate, minimum)));

  const moveMonth = (offset: number) => {
    if (offset < 0 && !canMovePrevious) return;
    setMotion(offset > 0 ? "next" : "prev");
    setDisplayMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  };

  const selectDay = (date: Date) => {
    const nextDate = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      selectedDate.getHours(),
      selectedDate.getMinutes(),
      0,
      0,
    );
    emitDate(nextDate);
  };

  const stepTime = (part: "hour" | "minute", amount: number) => {
    const nextDate = new Date(selectedDate);
    if (part === "hour") nextDate.setHours(nextDate.getHours() + amount);
    else nextDate.setMinutes(nextDate.getMinutes() + amount);
    emitDate(nextDate);
  };

  const commitTimeDraft = (part: "hour" | "minute") => {
    const draft = part === "hour" ? hourDraft : minuteDraft;
    const maximum = part === "hour" ? 23 : 59;
    const parsed = Number(draft);
    if (!draft.trim() || !Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
      setHourDraft(pad(selectedDate.getHours()));
      setMinuteDraft(pad(selectedDate.getMinutes()));
      return;
    }
    const nextDate = new Date(selectedDate);
    if (part === "hour") nextDate.setHours(parsed);
    else nextDate.setMinutes(parsed);
    emitDate(nextDate);
  };

  const renderTimeControl = (part: "hour" | "minute", label: string, draft: string) => (
    <div className="min-w-0 flex-1">
      <div className="mb-1.5 text-center text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
        {label}
      </div>
      <div className="flex h-10 items-center overflow-hidden rounded-lg border border-border bg-bg-primary shadow-sm shadow-black/[0.03] focus-within:border-accent">
        <button
          type="button"
          onClick={() => stepTime(part, -1)}
          disabled={disabled}
          className="flex h-full w-9 flex-shrink-0 items-center justify-center text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={`${label} -1`}
        >
          <Minus size={13} />
        </button>
        <input
          value={draft}
          onChange={(event) => {
            const nextValue = event.target.value.replace(/\D/g, "").slice(0, 2);
            if (part === "hour") setHourDraft(nextValue);
            else setMinuteDraft(nextValue);
          }}
          onBlur={() => commitTimeDraft(part)}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              stepTime(part, event.key === "ArrowUp" ? 1 : -1);
            }
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          disabled={disabled}
          inputMode="numeric"
          aria-label={label}
          className="h-full min-w-0 flex-1 border-x border-border bg-transparent text-center text-base font-semibold tabular-nums text-text-primary outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => stepTime(part, 1)}
          disabled={disabled}
          className="flex h-full w-9 flex-shrink-0 items-center justify-center text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={`${label} +1`}
        >
          <Plus size={13} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-bg-secondary/35 shadow-sm shadow-black/[0.025]">
      <div className="flex items-center justify-between border-b border-border bg-bg-sidebar/35 px-3 py-2.5">
        <button
          type="button"
          onClick={() => moveMonth(-1)}
          disabled={disabled || !canMovePrevious}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
          aria-label={t(lang, "previousMonth")}
        >
          <ChevronLeft size={16} />
        </button>
        <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <CalendarDays size={14} className="text-accent-text" />
          {new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(displayMonth)}
        </div>
        <button
          type="button"
          onClick={() => moveMonth(1)}
          disabled={disabled}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
          aria-label={t(lang, "nextMonth")}
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="p-3">
        <div className="mb-1 grid grid-cols-7 gap-1">
          {weekdays.map((weekday, index) => (
            <div key={`${weekday}-${index}`} className="flex h-6 items-center justify-center text-[11px] font-medium text-text-muted">
              {weekday}
            </div>
          ))}
        </div>
        <div
          key={`${displayMonth.getFullYear()}-${displayMonth.getMonth()}`}
          className={`calendar-motion calendar-motion-${motion} grid grid-cols-7 gap-1`}
        >
          {days.map((day) => {
            const isSelected = day.value === selectedValue;
            const isToday = day.value === todayValue;
            const isPast = endOfDay(day.date).getTime() < minimum.getTime();
            return (
              <button
                key={day.value}
                type="button"
                onClick={() => selectDay(day.date)}
                disabled={disabled || isPast}
                aria-pressed={isSelected}
                aria-label={new Intl.DateTimeFormat(locale, {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                  weekday: "short",
                }).format(day.date)}
                className={`relative h-8 rounded-lg text-xs tabular-nums transition-colors
                  ${isSelected
                    ? "bg-accent font-semibold text-on-accent shadow-sm shadow-accent/20"
                    : isToday
                      ? "bg-accent-light font-semibold text-accent-text"
                      : day.isCurrentMonth
                        ? "text-text-primary hover:bg-bg-hover"
                        : "text-text-muted/45 hover:bg-bg-hover"
                  }
                  ${isPast ? "cursor-not-allowed opacity-25" : "cursor-pointer"}`}
              >
                {day.date.getDate()}
                {isToday && !isSelected && (
                  <span className="absolute bottom-1 left-1/2 h-0.5 w-2 -translate-x-1/2 rounded-full bg-accent" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="border-t border-border bg-bg-sidebar/25 p-3">
        <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-accent/15 bg-accent-light px-3 py-2 text-xs text-accent-text">
          <span className="flex min-w-0 items-center gap-2 font-medium">
            <Clock3 size={13} className="flex-shrink-0" />
            <span className="truncate">
              {new Intl.DateTimeFormat(locale, {
                year: selectedDate.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
                month: "short",
                day: "numeric",
                weekday: "short",
              }).format(selectedDate)}
            </span>
          </span>
          <span className="flex-shrink-0 text-sm font-semibold tabular-nums">
            {pad(selectedDate.getHours())}:{pad(selectedDate.getMinutes())}
          </span>
        </div>
        <div className="flex items-end gap-2">
          {renderTimeControl("hour", t(lang, "scheduledPublishHour"), hourDraft)}
          <span className="mb-2 text-base font-semibold text-text-muted">:</span>
          {renderTimeControl("minute", t(lang, "scheduledPublishMinute"), minuteDraft)}
        </div>
      </div>
    </div>
  );
}
