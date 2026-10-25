// Trigger keys and fallback text for edits to shipped lore entries. AGPL-3.0-only.
// Adapted from VE v0.4.0 (e8a986d), by Venus Dev and VE contributors:
// https://github.com/venus-extracurriculars/build/tree/v0.4.0/src/renderer/prompts
export const SHIPPED_LORE = [
  {
    "ref": "city_life_dance_studio",
    "keys": [
      "Dance Studio",
      "dance studio",
      "dance lesson",
      "dance class"
    ],
    "text": "Dance Studio is a welcoming Downtown studio open every day and evening, with a sprung maple floor, mirrored walls, ballet barres, tall windows, a sound system and benches with cubbies. Anyone may visit, practice, take part in lessons or enjoy social dancing with friends or a willing date, regardless of dance skill, stats or employment. Dance Instructor is a paid job obtained only through the Jobs board after the player meets its requirements; merely visiting or narrating a lesson does not hire or pay the player. Robin Ellis directs the studio. During an actual scheduled instructor shift, the reader teaches beginners, demonstrates routines and supports nervous students. Background: dance_studio. Default clothing at this venue is PE wear for students and instructors, during visits, practice, lessons and teaching shifts. Use each character's existing PE outfit and _pe emotion sprites when that wardrobe is available; otherwise use their main outfit and available sprites. Keep the PE suffix until they change clothes. Honor an explicitly chosen different outfit or a change established in the scene. Preserve realistic physical limits and personal boundaries. Visits do not automatically award affection, improve stats or deduct fees; normal scene and job settlement handles rewards."
  },
  {
    "ref": "city_life_bowling_alley",
    "keys": [
      "Lucky Strike Lanes",
      "bowling",
      "bowling alley"
    ],
    "text": "Lucky Strike Lanes is a casual Downtown bowling alley near the cheap food and entertainment district. It opens every day and evening, with rental shoes, polished lanes, ball returns, comfortable seats and a snack counter. Friends can play friendly games, practice alone or arrange a low-pressure bowling date. Background: bowling_alley. Keep bowling scores and outcomes plausible; no automatic victories or affection rewards. Admission and rental prices are descriptive unless the player explicitly purchases something through an existing supported transaction; do not invent automatic money deductions."
  },
  {
    "ref": "city_life_roller_rink",
    "keys": [
      "Starlight Roller Rink",
      "roller skating",
      "roller rink",
      "skating rink"
    ],
    "text": "Starlight Roller Rink is a retro indoor roller-skating venue in Downtown, open every day and evening. It has a smooth maple rink, rental quad skates, benches, a snack lounge, pastel neon and a disco ball. Beginners can practice near the rail while experienced skaters enjoy laps and music. Friends, solo visitors and dates are welcome; offer encouragement and realistic stumbles without forcing touch, romance or success. Background: roller_rink. Admission and rental prices are descriptive unless explicitly purchased through an existing supported transaction; do not invent automatic money deductions."
  },
  {
    "ref": "city_life_cat_cafe",
    "keys": [
      "Purr & Pour",
      "cat cafe",
      "cat café",
      "cat lounge"
    ],
    "text": "Purr & Pour Cat Café is a cozy Downtown cafe open during native day and evening slots. Coffee and snacks are prepared in a separate counter area; the quiet cat lounge has climbing shelves, toys and comfortable seats. Visitors can enjoy a drink, read or gently play with cats who choose to approach. Staff explain house rules: respect resting cats, no chasing or forced handling, and keep human food away from them. Suitable for solo visits, friends or dates. Background: cat_cafe. No automatic affection or money deductions merely for visiting."
  },
  {
    "ref": "vsa",
    "keys": [
      "VSA",
      "student association",
      "CAPC",
      "SEB",
      "student organization",
      "student government"
    ],
    "text": "The VSA is a student association split into two powerful wings: The CAPC and the SEB. Thorne personally allows it to rival even the administration's authority. The CAPC (Campus Aesthetics and Planning Committee) manages the massive budget for interior design, seasonal decorations, and indoor plant life. The Student Engagement Board (SEB), which is responsible for organizing the university's relentless schedule of social events, mixers, and forums."
  },
  {
    "ref": "frederic_thorne",
    "keys": [
      "Frederic Thorne",
      "Thorne",
      "Freddy",
      "Thorne Philanthropies"
    ],
    "text": "Frederic Thorne is an eccentric tech billionaire and CEO of Thorne Philanthropies. Known for his controversial social media takes and for funding wildly expensive projects, he is idolized and demonized in equal measure by the student body, who has nicknamed him \"Freddy\". Catching sight of him on campus is considered to be an incredibly good omen, but he always makes sure to show up in disguise."
  },
  {
    "ref": "kendall_library",
    "keys": [
      "Kendall",
      "library",
      "libraries"
    ],
    "text": "The Kendall Library is a mix of grand, nostalgic architecture and high-tech affordances. Thick wooden shelves with ornate engravings are inlaid with screened terminals for navigation."
  },
  {
    "ref": "agora",
    "keys": [
      "Agora",
      "student center",
      "study pod",
      "cafeteria",
      "food court"
    ],
    "text": "The Agora is a glass-walled, multi-level student center containing two indoor waterfalls, app-booked study pods, a food court, and the sprawling Pino-Cola sponsored recreation center. The social heartbeat of campus."
  },
  {
    "ref": "pino_cola_lounge",
    "keys": [
      "Pino-Cola",
      "lounge"
    ],
    "text": "The Pino-Cola Lounge sits on the second floor of the Agora, a sprawling space crammed with study desks, video game setups, ping pong tables, old arcade machines, and more. Soda machines carrying its namesake's product dispense exclusive seasonal flavors. The go-to place for students who don't want to study \"too\" hard."
  },
  {
    "ref": "venus_quad",
    "keys": [
      "Venus Quad",
      "the quad",
      "Concord Fountain",
      "fountain"
    ],
    "text": "The Venus Quad is the sprawling, meticulously landscaped park at the center of campus. It features sunken fire pits, shaded gazebos, and a towering statue of Venus. At its center is the Concord Fountain, whose capacity as a wishing well is genuinely believed by the student body: the campus store sells special coins worth up to a thousand dollars to toss in, and about forty thousand dollars worth of coins are pulled from the water every semester and used to fund financial aid."
  },
  {
    "ref": "whitman_greenhouse",
    "keys": [
      "Whitman",
      "greenhouse",
      "botanical garden",
      "butterfly enclosure",
      "tropical pond"
    ],
    "text": "The Whitman Botanical Greenhouse, funded by heiress Cordelia Whitman, is a massive climate-controlled greenhouse at the campus's western edge. It is maintained by the CAPC and houses an orchard, a butterfly enclosure, and a tropical pond. Due to its maze-like nature, it's popular among couples for private walks."
  },
  {
    "ref": "thorne_auditorium",
    "keys": [
      "Thorne Auditorium",
      "auditorium",
      "concert",
      "recording studio",
      "recital",
      "practice room",
      "music practice"
    ],
    "text": "Thorne Auditorium sits near the east part of VU and can be entered without stepping onto VU campus proper. It seats 3000 and is a popular spot for indie performances and classical recitals due to its advanced acoustics: it has an advanced seashell-like design. The basement holds recording studios and practice rooms for students with musical interests. Thorne also regularly invites celebrities to give talks here whose tickets sell out in seconds."
  },
  {
    "ref": "palaestra_stadium",
    "keys": [
      "Palaestra",
      "stadium",
      "track and field",
      "the track",
      "gym",
      "gymnasium",
      "tennis",
      "pool"
    ],
    "text": "Palaestra Stadium is a gigantic athletics complex consisting not just of its namesake, but of several indoor gymnasiums, a pool, tennis courts, real-grass turfs, and a rooftop running track."
  },
  {
    "ref": "elysium_village",
    "keys": [
      "Elysium Village",
      "elysium",
      "townhouse",
      "senior housing",
      "senior living"
    ],
    "text": "Elysium Village is the row of west-edge townhouses with spacious rooms, private patios, and surrounding woodland, claimed almost entirely by upperclassmen through a housing lottery, so an invite to a party there feels like being knighted. Residents keep a porch light code: on means visitors welcome, off means do not perceive me."
  },
  {
    "ref": "lowrise_dorms",
    "keys": [
      "Lowrise",
      "dorm",
      "student housing",
      "dormitory",
      "dormitories"
    ],
    "text": "The Lowrises, numbered one through five, house the bulk of the dorming student population. Apartment-style, four to six stories, each arranged around a courtyard. All rooms are single-occupancy but share bathrooms, kitchens, and common areas. Student volunteers prepare communal dinners in the kitchens every night, with Lowrise 3's Sunday being so popular a waitlist is enforced."
  },
  {
    "ref": "bunnyboard",
    "keys": [
      "Bunnyboard",
      "social media",
      "dating app"
    ],
    "text": "Bunnyboard is VU's student-only social media platform. Originally created as a dating app by a later-expelled CS major, it's now also a forum where students can get advice, spread rumors, and keep up with trends. Most students text via Bunnyboard exclusively so it's borderline impossible to have a social life at VU without it."
  },
  {
    "ref": "downtown",
    "keys": [
      "Downtown",
      "Silktown"
    ],
    "text": "Downtown, called Silktown by longtime locals, is Veridan's historic core of brick mill buildings, family restaurants, and ordinary shops. Its residents have campaigned to keep new money out of its borders."
  },
  {
    "ref": "green_hill_park",
    "keys": [
      "Green Hill",
      "Green Hill Park",
      "the park",
      "public park"
    ],
    "text": "Green Hill Park is Downtown's lovingly maintained public park. It stretches over rolling, well-manicured hills of grass, cobbled paths, and marble memorials. At night, it's far enough from the skyscrapers to offer a real view of the stars. It's said to have once been a sacred Native American ground dedicated to fertility and is a popular place to propose."
  },
  {
    "ref": "lotterdale_market",
    "keys": [
      "Lotterdale",
      "flea market",
      "farmer's market",
      "farmers market"
    ],
    "text": "Lotterdale Farmer's and Flea Market is a garage sale style market that lives inside a set of conjoined barnhouses and warehouses. \"Lotterdale tax\" is part of Veridan's local parlance and refers to how one can come looking for produce or records and leave with trinkets instead."
  },
  {
    "ref": "reserve_bank_cafe",
    "keys": [
      "Reserve Bank",
      "cafe",
      "coffee shop",
      "coffee"
    ],
    "text": "Reserve Bank Cafe lives inside a 1920s bank abandoned after an unsolved heist emptied its vault, a history it leans into with drinks like the Getaway Latte. Seats inside the vault are reservation-only and booked weeks out. It's close to campus, so half of VU detours here each morning rather than gamble on campus coffee."
  },
  {
    "ref": "bobbys_diner",
    "keys": [
      "Bobby's Diner",
      "diner"
    ],
    "text": "Bobby's Diner is a cozy diner right at the center of Downtown whose menu hasn't changed since it was established after World War II. It leans into its history with period-appropriate costumes for its waitresses (the diner is known for not hiring waiters) and it's still run by a Bobby related to the original owner."
  },
  {
    "ref": "spring_mart",
    "keys": [
      "SpringMart",
      "supermarket",
      "grocery",
      "groceries"
    ],
    "text": "SpringMart is Veridan's only supermarket, grown from a corner store and immune to every chain that has tried to invade. It carries groceries and everyday goods and employs half the teenagers in Silktown."
  },
  {
    "ref": "fast_eats",
    "keys": [
      "Fast Eats",
      "fast food",
      "burger",
      "fried chicken",
      "ice cream",
      "tex-mex",
      "pizza"
    ],
    "text": "Fast Eats is a Veridan fast food chain that cannot decide what it sells: burgers, tex-mex, fried chicken, ice cream, pizza, and much more crammed in a menu the size of a newspaper. Each of its five Veridan locations has its own secret menu. The Downtown flagship is the largest and has an attached play area often raided unabashedly by adults."
  },
  {
    "ref": "pier_44",
    "keys": [
      "Pier 44",
      "boardwalk",
      "carousel",
      "theme park",
      "amusement park",
      "ferris wheel"
    ],
    "text": "Pier 44 is a riverside amusement park built around a restored antique carousel. The boardwalk is free and the prices of the cheap rides haven't changed in decades. At night, the sky above the park sports a beautiful assortment of colored string lights, and its huge ferris wheel makes up a part of Veridan's skyline."
  },
  {
    "ref": "stanchion_st",
    "keys": [
      "Stanchion",
      "Stanchion St"
    ],
    "text": "Stanchion St. is an outdoor walking district sheltered overhead by a tangle of highway overpasses. Historically a poorer part of town, residents barricaded it in the 1980s when the city refused to fix the dangerous, crumbling concrete, and the barricades never came down. Now it is the cheap food and entertainment district, its pillars layered in decades of murals, its highway ceiling giving a permanent cozy dusk lit by hanging lanterns."
  },
  {
    "ref": "btb_arcade",
    "keys": [
      "BTB",
      "arcade",
      "PARADISO",
      "beat-the-beat"
    ],
    "text": "BTB (Beat-the-Beat) Arcade is a warehouse-sized retro arcade dating to the Pac-Man era. Nowadays, it carries modern arcade games too, such as PARADISO, a brutally exhausting dance game whose song releases draw lines around the block. Having your name on the leaderboard here regularly carries prestige, and they're beaten almost every other week."
  },
  {
    "ref": "stalestein_bar",
    "keys": [
      "Stalestein",
      "bar",
      "open mic"
    ],
    "text": "The Stalestein is a grimy underground Prohibition-era bar where ravers, indie bands, pickup artists, and bikers get along with no problems. It has a small stage that hosts open mic nights, metal bands, and other quirky acts in a packed, rotating schedule."
  },
  {
    "ref": "hotel_dreams",
    "keys": [
      "Hotel DREAMS",
      "love hotel",
      "massage"
    ],
    "text": "Hotel DREAMS markets itself as a \"boutique\" hotel with themed rooms, but locals know it as a shady spot where you pay in cash and can book rooms by the hour. It sports an attached massage parlor with suspiciously attractive masseuses of both genders."
  },
  {
    "ref": "pastel_palace",
    "keys": [
      "Pastel Palace",
      "bakery",
      "bakeries",
      "pastry",
      "pastries",
      "sweets"
    ],
    "text": "Pastel Palace is a trendy sweets place that regularly goes viral on Bunnyboard for limited time pastries and goods, sometimes selling out within the hour. The store only offers couple seating, but offers heavy discounts to singles."
  },
  {
    "ref": "cutetea",
    "keys": [
      "CuteTea",
      "Cute Tea",
      "bubble tea",
      "boba",
      "board game"
    ],
    "text": "CuteTea is a Veridan-only chain serving bubble tea, coffee, and board games that you can borrow. It has three locations in Veridan, but the Stanchion St. location is the original and the largest."
  },
  {
    "ref": "eastern_buffet",
    "keys": [
      "Eastern Buffet",
      "asian food",
      "chinese food",
      "japanese food",
      "korean food",
      "buffet"
    ],
    "text": "Eastern Buffet is an absurdly cheap Korean, Japanese, and Chinese buffet. It's twelve dollars at the door, and is open 24/7. It hosts student eating showdowns whose champions are framed by the register. Its owner is rumored to launder money for the Yakuza, which is lent credence by the fact that he regularly allows people to eat for free if they ask."
  },
  {
    "ref": "promenade",
    "keys": [
      "Promenade",
      "skyscraper"
    ],
    "text": "The Promenade is Veridan's newest district: glass towers, luxury brands, and animated billboards all built with money that flooded in after VU opened. Everything is beautiful, the rent is astronomical, and there is near-constant construction."
  },
  {
    "ref": "riverside_mall",
    "keys": [
      "Riverside Mall",
      "Riverside",
      "mall"
    ],
    "text": "The Riverside Mall is a four-story glass-and-steel complex of retail, restaurants, and recreation. Topped by a rooftop terrace with the best daytime river view, its floors spiral around a multi-story kinetic sculpture called the \"Threads\". It is the first stop to buy an expensive gift for someone, with nothing on the upper floors costing less than three digits. Below that lies more affordable attractions for the general populace: laser tag, VR experiences, pop-up shops, and more."
  },
  {
    "ref": "riverside_aquarium",
    "keys": [
      "Aquarium at Riverside",
      "aquarium",
      "jellyfish",
      "Duchess"
    ],
    "text": "The Aquarium at Riverside is a curved building next to the Riverside Mall that appears to dip into the river, with a glass tunnel running under the actual riverbed. Its star is Duchess, a giant Pacific octopus who lives outside the aquarium proper but is trained to visit an observation room at certain times of day. Its jellyfish room, lit only by the tanks and built to have private nooks, has a waiting list filled by couples."
  },
  {
    "ref": "selkie_beach",
    "keys": [
      "Selkie Beach",
      "selkie",
      "beach",
      "Silky Way",
      "cabana",
      "jet ski",
      "jet-ski",
      "jetski",
      "boat"
    ],
    "text": "Selkie Beach is the Promenade's manufactured riverfront resort strip: imported white sand trucked in by the barge-load, cabana bars with prices as exotic as their drinks, jet-ski and boat rentals, and a row of glass beachside hotels. Its name comes from a mill-era immigrant who kept insisting to anyone who would listen that the river shore here was \"silky,\" which everyone heard as a claim that he had seen a selkie. A resort conglomerate bought the whole strip after VU opened and failed to rebrand it \"The Silky Way,\" and the massive sign now serves as a meet-up point."
  },
  {
    "ref": "future_cinema",
    "keys": [
      "Future Cinema",
      "theater",
      "theatre",
      "cinema"
    ],
    "text": "Future Cinema is a national chain theater connected to the Riverside Mall on the first and second floors. It features a \"palatial\" theme with gilded marble and velvet. It shows classic films every midnight."
  },
  {
    "ref": "apogee_club",
    "keys": [
      "Club Apogee",
      "Apogee",
      "nightclub"
    ],
    "text": "Club Apogee occupies the top two floors of a Promenade skyscraper, with a terrifying section built entirely out of glass and overlooking a forty story drop. Celebrity DJs are paid enormous sums to play here in disguise, and the bar prices pay for it. The club is rumoured to have an \"anything goes\" policy: in its dark corners, drugs and even public sex is allowed. It's also known to have ties to organized crime and is definitely not a wholesome place to go with your future wife. It opens Tuesday through Saturday nights."
  },
  {
    "ref": "lumiere_fusion",
    "keys": [
      "Lumiere Fusion",
      "Lumiere",
      "fine dining"
    ],
    "text": "Lumiere Fusion is a reservations-only culinary incubator where the chef changes everyday. There is no menu: you simply pay an absurd three digit door fee and are served. The restaurant suffered a minor controversy when they attempted to serve \"food\" made of paper, but they also regularly craft culinary experiences that are written about in other countries. Dinner service runs every night, and brunch is served on Saturday and Sunday."
  },
  {
    "ref": "veridan_museum",
    "keys": [
      "Veridan Museum",
      "Museum of Art",
      "art museum",
      "museum",
      "Girl at the Window"
    ],
    "text": "The Veridan Museum of Art is built partly from salvaged wood, looms and rebar, offering both contemporary and classical galleries. The ceiling is a gravity-defying upside-down garden that blooms year round. Its famous holding is \"Girl at the Window,\" a portrait pulled from a mill fire whose subject was never identified. Leaving a flower at her frame is a local tradition for the heartbroken."
  },
  {
    "ref": "freights_books",
    "keys": [
      "Freights",
      "records",
      "bookstore",
      "record store",
      "vinyl",
      "book shop",
      "record shop"
    ],
    "text": "Freights Books & Records operates out of a 1960s freight warehouse on Stanchion Street. The shop's lobby wall is covered in yellowed, signed photos of visiting musicians and indie authors visiting the store. It's notorious for its bargain-bin pricing, extensive manga collection, and an entirely unorganized, labyrinthian layout spanning two floors. The towering shelves are periodically broken up by curtained reading nooks used more often as makeout spots."
  }
];
