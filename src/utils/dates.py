from datetime import datetime, timedelta, timezone


def week_start(value=None):
    value = value or datetime.now(timezone.utc).date()
    if isinstance(value, datetime):
        value = value.date()
    return value - timedelta(days=value.weekday())
