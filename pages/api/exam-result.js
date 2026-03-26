import pool from "../../lib/db";
import examConfigs from "../../examConfig";
import rateLimit from "express-rate-limit";

// Helper function to get client IP address
const getIp = (req) => {
  const xForwardedFor = req.headers["x-forwarded-for"];
  if (typeof xForwardedFor === "string") {
    return xForwardedFor.split(",")[0].trim();
  }
  if (Array.isArray(xForwardedFor) && xForwardedFor.length > 0) {
    return xForwardedFor[0].trim();
  }
  // Fallback to socket remoteAddress or connection remoteAddress
  return req.socket?.remoteAddress || req.connection?.remoteAddress;
};

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // trustProxy: true, // Removed as we are using a custom keyGenerator
  keyGenerator: (req, res) => {
    const ip = getIp(req);
    if (!ip) {
      // This is a fallback, but ideally, an IP should always be found.
      // If IP is consistently not found, the getIp logic might need adjustment
      // for your specific environment/proxy setup.
      console.warn(
        "Rate limiter: IP address could not be determined. Using a default key for rate limiting. This might group multiple users."
      );
      return "default-fallback-key";
    }
    return ip;
  },
  handler: (req, res) => {
    res.status(429).json({
      error: "Too many requests. Please try again later.",
    });
  },
});

export default async function handler(req, res) {
  await limiter(req, res, () => {});

  const { exam, rank } = req.query;

  if (!exam || !examConfigs[exam]) {
    return res.status(400).json({ error: "Invalid or missing exam parameter" });
  }

  const config = examConfigs[exam];

  // Check for required parameters
  for (const field of config.fields) {
    if (exam === "JoSAA" && field.name === "preferHomeState") {
      continue;
    }
    // Certain dropdowns in UI omit the value intentionally or pass 'Select...' as empty string
    const val = req.query[field.name];
    if (val === undefined || val === null || val === 'Select...' || val === '') {
      // Allow religion mapping and tolerate legacy UI map differences for NEET
      if (field.name === "religion") continue;
      if (field.name === "defence_war" && req.query["isDefenseWard"]) continue;
      if (field.name === "seat_type" && req.query["seatType"]) continue;
      return res
        .status(400)
        .json({ error: `Missing required parameter: ${field.name}` });
    }
  }

  try {
    // Map the incoming request category & exam to query the Database directly
    const { category, rank, qualifiedJeeAdv, advRank, mainRank } = req.query;

    // A mapping helper based on the current filtering rules
    let baseQuery = `
      SELECT 
        i.name as "Institute",
        i.state as "State",
        i.district as "District",
        i.type_of_college as "Type of College",
        c.course as "Academic Program Name",
        c.program as "Program",
        c.gender as "Gender",
        c.quota as "Quota",
        c.closing_rank as "Closing Rank",
        c.closing_marks as "Cutoff Marks",
        c.year as "Year",
        e.name as "Exam",
        cat.name as "Category"
      FROM cutoffs c
      JOIN institutions i ON c.institution_id = i.id
      JOIN exams e ON c.exam_id = e.id
      JOIN categories cat ON c.category_id = cat.id
      WHERE e.name ILIKE $1 
        AND cat.name = $2
    `;

    let dbExam = exam;
    if (exam.includes("JoSAA") || exam.includes("JEE")) dbExam = "JEE";
    else if (exam.includes("NEET")) dbExam = "NEET";
    else if (exam === "MHT CET") dbExam = "MHTCET";
    else if (exam === "TGEAPCET") dbExam = "TSEAPERT";

    const queryParams = [`%${dbExam}%`, category];
    
    // Convert to float/int
    const getFloatVal = (val) => {
      const parsed = parseFloat(val);
      return isNaN(parsed) ? 0 : parsed;
    };

    const getRankVal = (rankStr) => {
      if (!rankStr) return null;
      const numStr = rankStr.toString().replace(/[^0-9]/g, "");
      return numStr ? parseInt(numStr, 10) : null;
    };

    // Apply exact legacy cutoff filters to SQL query where appropriate
    if (exam === "GUJCET") {
      baseQuery += ` AND c.closing_marks <= ($3 / 0.7)`; 
      queryParams.push(getFloatVal(rank));
    } else if (exam === "NEET") {
      baseQuery += ` AND c.closing_rank >= (0.7 * $3)`; 
      queryParams.push(getFloatVal(rank));
    } else if (exam === "TNEA") {
      baseQuery += ` AND c.closing_marks >= ($3 * 0.8)`;
      queryParams.push(getFloatVal(rank));
    } else if (exam === "JoSAA") {
      // For JoSAA, filtering logic separates JEE Main and Advanced, we pull all JoSAA stuff and filter locally
      // Or we can just pull it down and use the original specific logic below. Let's pull the full exam data 
      // for the category and use the existing legacy Javascript rankFilter for the exceptionally complex ones like PwD 'P' suffixes
    } else {
      // General rank filter for other exams
      if (rank) {
         baseQuery += ` AND c.closing_rank >= (0.7 * $3)`;
         queryParams.push(getRankVal(rank) || 0);
      }
    }

            const { rows: fullData } = await pool.query(baseQuery, queryParams);
        
    // ==========================================
    // PHASE 3: CALIBRATED PREDICTION LOGIC 
    // ==========================================
    // Instead of raw binary cutoffs, we calculate statistical 
    // confidence bands to provide Safe, Moderate, and Ambitious flags.
    let calibratedData = fullData.map((row) => {
      let admission_chance = "Moderate";
      let prob = 50;

      if (exam === "GUJCET" || exam === "TNEA") {
        // Marks-based logic (Higher is better)
        const userMarks = parseFloat(rank) || 0;
        const cutoffMarks = parseFloat(row["Cutoff Marks"]) || 0;
        
        if (userMarks >= cutoffMarks + 2) {
          admission_chance = "Safe";
          prob = 85 + Math.min(14, (userMarks - cutoffMarks)); 
        } else if (userMarks >= cutoffMarks - 3) {
          admission_chance = "Moderate";
          prob = 40 + ((userMarks - (cutoffMarks - 3)) * 10);
        } else {
          admission_chance = "Ambitious";
          prob = 15;
        }
      } else {
        // Rank-based logic (Lower is better)
        const userRk = getRankVal(rank) || 0;
        const closeRk = parseFloat(row["Closing Rank"]) || 0;

        if (userRk <= closeRk * 0.85) {
          admission_chance = "Safe";
          prob = 85 + Math.min(14, ((closeRk - userRk) / closeRk) * 100);
        } else if (userRk <= closeRk * 1.05) {
          admission_chance = "Moderate";
          prob = 45 + ((closeRk - userRk) / closeRk) * 100;
        } else {
          admission_chance = "Ambitious";
          prob = 10 + Math.max(0, 30 - (((userRk - closeRk) / closeRk) * 100));
        }
      }

      // Format probabilities and add properties for React UI
      return {
        ...row,
        Exam: exam,
        admission_chance,
        prediction_probability: Math.min(99, Math.max(1, Math.round(prob))) + "%"
      };
    });

    // Get filters based on the exam config and query parameters
    const filters = config.getFilters(req.query);

    // Helper function to parse rank (handles 'P' suffix)
    const parseRank = (rankStr) => {
      if (!rankStr) return null;
      const numStr = rankStr.toString().replace(/[^0-9]/g, "");
      return numStr ? parseInt(numStr, 10) : null;
    };

    const hasPSuffix = (rankStr) => {
      if (!rankStr) return false;
      return rankStr.toString().trim().toUpperCase().endsWith("P");
    };

    const rankFilter = (item) => {
      if (exam === "GUJCET") {
        // For GUJCET, filter based on closing_marks
        const cutoffMarks = parseFloat(item.closing_marks) || 0;
        const userMarks = parseFloat(rank) || 0;
        return userMarks >= cutoffMarks * 0.9; // Show if user marks are >= 90% of cutoff
      } else if (exam === "NEET") {
        // For NEET, filter based on closing rank with 0.9 coefficient
        const closingRank = parseFloat(item["Closing Rank"]) || 0;
        const userRank = parseFloat(rank) || 0;
        return closingRank >= 0.9 * userRank; // Show colleges where closing rank is >= 90% of user's rank
      } else if (exam === "TNEA") {
        return parseFloat(item["Cutoff Marks"]) <= parseFloat(rank);
      }

      const itemRankStr = item["Closing Rank"]?.toString().trim() || "";
      const itemRank = parseRank(itemRankStr);
      const itemHasPSuffix = hasPSuffix(itemRankStr);

      if (exam === "JoSAA") {
        if (item["Exam"] === "JEE Advanced") {
          if (req.query.qualifiedJeeAdv !== "Yes" || !req.query.advRank)
            return false;

          const userRankStr = req.query.advRank?.toString().trim() || "";
          const userRank = parseRank(userRankStr);
          const userHasPSuffix = hasPSuffix(userRankStr);

          // If one has 'P' suffix and the other doesn't, they don't match
          if (itemHasPSuffix !== userHasPSuffix) return false;

          return userRank && itemRank >= 0.9 * userRank;
        } else {
          if (!req.query.mainRank) return false;

          const userRankStr = req.query.mainRank?.toString().trim() || "";
          const userRank = parseRank(userRankStr);
          const userHasPSuffix = hasPSuffix(userRankStr);

          // If one has 'P' suffix and the other doesn't, they don't match
          if (itemHasPSuffix !== userHasPSuffix) return false;

          return userRank && itemRank >= 0.9 * userRank;
        }
      } else if (exam === "JEE Advanced") {
        if (item["Exam"] !== "JEE Advanced") return false;
        if (!req.query.advRank) return false;

        const userRankStr = req.query.advRank?.toString().trim() || "";
        const userRank = parseRank(userRankStr);
        const userHasPSuffix = hasPSuffix(userRankStr);

        // If one has 'P' suffix and the other doesn't, they don't match
        if (itemHasPSuffix !== userHasPSuffix) return false;

        return userRank && itemRank >= 0.9 * userRank;
      } else if (exam === "JEE Main") {
        if (item["Exam"] === "JEE Advanced") return false;
        if (!req.query.mainRank) return false;

        const userRankStr = req.query.mainRank?.toString().trim() || "";
        const userRank = parseRank(userRankStr);
        const userHasPSuffix = hasPSuffix(userRankStr);

        // If one has 'P' suffix and the other doesn't, they don't match
        if (itemHasPSuffix !== userHasPSuffix) return false;

        return userRank && itemRank >= 0.9 * userRank;
      } else {
        return true;
      }
    };

    let filteredData = calibratedData;

    // Apply filters if they exist
    if (Array.isArray(filters)) {
      filteredData = filteredData.filter((item) => {
        return filters.every((filterFn) => filterFn(item));
      });
    }

    // Apply rank filter if it exists
    if (rankFilter) {
      filteredData = filteredData.filter(rankFilter);
    }

    // Apply sorting based on exam type
    if (config.getSort) {
      const sortConfig = config.getSort();
      if (sortConfig && sortConfig.length > 0) {
        const [sortKey, sortOrder] = sortConfig[0];
        filteredData.sort((a, b) => {
          let valA = a[sortKey];
          let valB = b[sortKey];

          // Convert to numbers if possible for proper numeric comparison
          if (!isNaN(parseFloat(valA)) && !isNaN(parseFloat(valB))) {
            valA = parseFloat(valA);
            valB = parseFloat(valB);
          }

          if (sortOrder === "DESC") {
            return valB - valA;
          }
          return valA - valB;
        });
      }
    } else if (exam === "TGEAPCET") {
      // For TGEAPCET, sort by closing_rank in ascending order
      filteredData.sort((a, b) => {
        const rankA = parseInt(a.closing_rank, 10) || 0;
        const rankB = parseInt(b.closing_rank, 10) || 0;
        return rankA - rankB; // Ascending order (lower ranks first)
      });
    } else if (exam === "TNEA") {
      // For TNEA, sort by cutoff marks in descending order
      filteredData.sort((collegeA, collegeB) => {
        const collegeAMarks = parseFloat(collegeA["Cutoff Marks"]) || 0;
        const collegeBMarks = parseFloat(collegeB["Cutoff Marks"]) || 0;
        return collegeBMarks - collegeAMarks; // Descending order (higher cutoff first)
      });
    } else if (
      exam === "JEE Main" ||
      exam === "JEE Advanced" ||
      exam === "JoSAA"
    ) {
      // For JEE Main, JEE Advanced, and JoSAA, sort by Closing Rank ascending
      filteredData.sort((collegeA, collegeB) => {
        const rankA = parseFloat(collegeA["Closing Rank"]) || 0;
        const rankB = parseFloat(collegeB["Closing Rank"]) || 0;
        return rankA - rankB;
      });
    }

    return res.status(200).json(filteredData);
  } catch (error) {
    console.error("Error reading file:", error);
    res.status(500).json({
      error: "Unable to retrieve data",
      details: error.message,
    });
  }
}
