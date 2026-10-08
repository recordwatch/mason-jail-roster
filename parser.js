import { parseBookingDate, toIsoDateTime } from './utils.js';

// Extract bookings from roster text
function extractBookings(rosterText) {
  const bookings = new Map();
  const blocks = rosterText.split(/(?=Booking #:)/);

  for (const block of blocks) {
    if (!block.includes("Booking #:")) continue;

    const bookingMatch = block.match(/Booking #:\s*(\S+)/);
    if (!bookingMatch) continue;
    const id = bookingMatch[1];

    const nameMatch = block.match(/Name:\s*([A-Z][A-Z\s,.'"-]+?)(?=\s*Name Number:|$)/i);
    let name = nameMatch ? nameMatch[1].trim().replace(/\s+/g, " ") : "Unknown";
    if (name.endsWith(",")) {
      const nextLine = block.match(/Name:\s*[^\n]+\n([A-Z][A-Z\s'-]*)/i);
      if (nextLine) name = name + " " + nextLine[1].trim();
    }

    const bookDateMatch = block.match(/Book Date:\s*(\d{1,2}:\d{2}:\d{2})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/);
    let bookDate = "Unknown";
    if (bookDateMatch) {
      const iso = toIsoDateTime(bookDateMatch[2], bookDateMatch[1]);
      // Reject garbage dates (rollovers, out-of-range years) instead of trusting the raw regex match.
      if (parseBookingDate(iso)) {
        bookDate = iso;
      } else {
        console.warn(`Booking ${id}: rejecting invalid Book Date "${bookDateMatch[2]} ${bookDateMatch[1]}"`);
      }
    }

    const relDateMatch = block.match(/Rel Date:\s*(?:No Rel Date|(\d{1,2}:\d{2}:\d{2})\s+(\d{1,2}\/\d{1,2}\/\d{2,4}))/);
    let releaseDate = "Not Released";
    if (relDateMatch && relDateMatch[1] && relDateMatch[2]) {
      const iso = toIsoDateTime(relDateMatch[2], relDateMatch[1]);
      if (parseBookingDate(iso)) {
        releaseDate = iso;
      } else {
        console.warn(`Booking ${id}: rejecting invalid Rel Date "${relDateMatch[2]} ${relDateMatch[1]}"`);
      }
    }

    const charges = [];
    // Same charges as above, plus the court (SUPR/DIST/MUNI/DOC) and offense
    // class ("FELONY", "GROSS MISDEMEANOR", ...) that follow each offense on
    // the line — the closest thing to a severity measure the roster has.
    const chargeDetails = [];
    const lines = block.split("\n");
    let inCharges = false;

    for (const line of lines) {
      const t = line.trim();

      // Start capturing after header (flexible matching)
      if (t.includes("StatuteOffense") || (t.includes("Statute") && t.includes("Offense"))) {
        inCharges = true;
        continue;
      }

      // If we're in charges section and line has content
      if (inCharges && t.length > 0) {
        // Skip header lines and page markers
        if (t.includes("Name Number:") || t.includes("Book Date:") ||
            t.includes("Rel Date:") || t.includes("Page ") ||
            t.includes("rpjlciol") || t.includes("Current Inmate") ||
            t.includes("StatuteOffense")) {
          continue;
        }

        // Look for lines that contain court types
        if (t.includes('SUPR') || t.includes('DIST') || t.includes('MUNI') || t.includes('DOC')) {
          // Remove statute code at the beginning (numbers, dots, letters in parentheses)
          let cleaned = t.replace(/^[\d.()A-Z]+(?=[A-Z][a-z])/, '');

          // Capture the court type and whatever follows it (the offense
          // class) before removing them from the offense text
          const courtMatch = cleaned.match(/(SUPR|DIST|MUNI|DOC)(.*)$/);
          const court = courtMatch ? courtMatch[1] : null;
          const offenseClass = courtMatch && courtMatch[2].trim() ? courtMatch[2].trim() : null;

          // Remove everything from the court type onwards
          cleaned = cleaned.replace(/(SUPR|DIST|MUNI|DOC).*$/, '');

          // What's left should be the offense name
          cleaned = cleaned.trim();

          if (cleaned.length > 2) {
            // A long offense description that wraps across multiple PDF
            // lines repeats the court-type marker on each wrapped line, so
            // each fragment would otherwise be pushed as its own charge
            // (e.g. "Burglary" / "Resident" / "Unlawf Ent" as three separate
            // charges instead of one "Burglary Resident Unlawf Ent"). Every
            // real charge line starts with a statute code (a leading digit);
            // a fragment with no leading digit is a continuation of the
            // previous charge, not a new one.
            if (!/^\d/.test(t) && charges.length > 0) {
              charges[charges.length - 1] += ' ' + cleaned;
              chargeDetails[chargeDetails.length - 1].offense += ' ' + cleaned;
            } else {
              charges.push(cleaned);
              chargeDetails.push({ offense: cleaned, court, offenseClass });
            }
          }
        }
      }
    }
    bookings.set(id, {
      id,
      name,
      bookDate,
      releaseDate,
      charges: [...new Set(charges)],
      chargeDetails: [...new Map(chargeDetails.map(c => [`${c.offense}|${c.court}|${c.offenseClass}`, c])).values()]
    });
  }
  return bookings;
}

export { extractBookings };
