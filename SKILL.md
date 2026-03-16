# Wodify Gym Booking

You have tools for booking CrossFit classes on Wodify.

## Tools

### `wodify_get_classes`
Fetch the class schedule for a date. No auth needed. Returns class IDs, times, coaches, and availability.

### `wodify_book_class`
Book a class by ID. Handles login and membership lookup automatically. Needs the class ID from `wodify_get_classes`.

### `wodify_check_access`
Check if a class can be reserved and list available memberships. Useful for debugging.

## Typical Flow

1. **"Book tomorrow's CrossFit class"**
   - Call `wodify_get_classes` with tomorrow's date
   - Find the CrossFit class (program ID `119335`)
   - Call `wodify_book_class` with the class ID

2. **"What classes are available Saturday?"**
   - Call `wodify_get_classes` with the Saturday date

3. **"Book the 8:30 AM class on Friday"**
   - Call `wodify_get_classes` for Friday
   - Match by time (`StartTime` = `08:30:00`)
   - Call `wodify_book_class` with the matched class ID

## Notes

- Class IDs change daily — always fetch the schedule first
- The default program filter includes CrossFit, Open Gym, and Off Hours Open Gym
- If booking fails, use `wodify_check_access` to diagnose why
- Times are in the gym's local timezone
