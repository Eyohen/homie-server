require('dotenv').config();
const db = require('../models');
const { computePricing } = require('../services/booking.service');

const { Member, ChefProfile, ChefService, Booking, BookingPayment, BookingReview } = db;

// Demo accounts for development: 24 verified chefs (3 per cuisine) with photos, menus and reviews,
// plus 3 hirers. Safe to run repeatedly. Sign in with the phone numbers below; in development the
// one-time code is shown on screen / returned by the API.
//   Chefs:  +2348000000001 … +2348000000024
//   Hirers: +2348100000001 … +2348100000003

const photo = (id) => `https://images.unsplash.com/photo-${id}?w=800&q=70&auto=format&fit=crop`;
const portrait = (gender, n) => `https://randomuser.me/api/portraits/${gender === 'F' ? 'women' : 'men'}/${n}.jpg`;

// Food photo pools per cuisine (Unsplash photo ids).
const POOLS = {
  Nigerian: ['1604329760661-e71dc83f8f26', '1630409351217-bc4fa6422075', '1512058564366-18510be2db19', '1603133872878-684f208fb84b', '1569058242253-92a9c755a0ec', '1555939594-58d7cb561ad1', '1599487488170-d11ec9c172f0'],
  Japanese: ['1579871494447-9811cf80d66c', '1583623025817-d180a2221d0a', '1553621042-f6e147245754', '1569718212165-3a8278d5f624', '1526318896980-cf78c088247c', '1546069901-ba9599a7e63c', '1555126634-323283e090fa'],
  Baking: ['1578985545062-69928b1d9587', '1486427944299-d1955d23e34d', '1551024601-bec78aea704b', '1484723091739-30a097e8f929', '1567620905732-2d1ec7ab7445', '1587314168485-3236d6710814'],
  Chinese: ['1496116218417-1a781b1c416c', '1534422298391-e4f8c172dddb', '1563245372-f21724e3856d', '1512003867696-6d5ce6835040', '1585032226651-759b368d7246', '1617093727343-374698b1b08d', '1603133872878-684f208fb84b', '1555126634-323283e090fa'],
  Italian: ['1513104890138-7c749659a591', '1565299624946-b28f40a0ae38', '1563379926898-05f4575a45d8', '1621996346565-e3dbc646d9a9', '1529042410759-befb1204b468', '1473093295043-cdd812d0e601'],
  Continental: ['1414235077428-338989a2e8c0', '1432139555190-58524dae6a55', '1558030006-450675393462', '1504674900247-0877df9cc836', '1482049016688-2d3e1b311543', '1490645935967-10de6ba17061', '1476224203421-9ac39bcb3327'],
  Indian: ['1565557623262-b51c2513a641', '1604908176997-125f25cc6f3d', '1567188040759-fb8a883dc6d8', '1574484284002-952d92456975', '1585937421612-70a008356fbe', '1596797038530-2c107229654b', '1601050690597-df0568f70950', '1589302168068-964664d93dc0', '1606491956689-2ea866880c84', '1631452180519-c014fe946bc7'],
  Grills: ['1599487488170-d11ec9c172f0', '1544025162-d76694265947', '1529193591184-b1d58069ecdd', '1555939594-58d7cb561ad1', '1558030006-450675393462', '1569058242253-92a9c755a0ec', '1504674900247-0877df9cc836'],
};

const AREAS = {
  Lekki: [6.4474, 3.4723], 'Victoria Island': [6.4281, 3.4219], Ikoyi: [6.4549, 3.4346], Ikeja: [6.6018, 3.3515],
  Surulere: [6.5010, 3.3580], Yaba: [6.5095, 3.3711], Ajah: [6.4698, 3.5852], Maryland: [6.5694, 3.3639],
  Magodo: [6.6150, 3.3830], Gbagada: [6.5527, 3.3874], Festac: [6.4667, 3.2833], 'Banana Island': [6.4590, 3.4410],
};

const SERVICE_COPY = {
  Nigerian: ['Party jollof, small chops or a soup of your choice. Serves 6–8', 'Full Nigerian menu for up to 12 guests, groceries extra'],
  Japanese: ['Sushi platter or ramen kit. Serves 6–8', 'Omakase-style dinner cooked at your table, groceries extra'],
  Baking: ['Celebration cake, pastry box or dessert table item', 'Cake plus dessert table for up to 30 guests'],
  Chinese: ['Dim sum or wok dishes. Serves 6–8', 'Multi-course Chinese banquet for up to 12 guests, groceries extra'],
  Italian: ['Handmade pasta or pizza. Serves 6–8', 'Three-course Italian dinner for up to 12 guests, groceries extra'],
  Continental: ['Signature main with sides. Serves 6–8', 'Plated three-course dinner for up to 12 guests, groceries extra'],
  Indian: ['Curries, rice and breads. Serves 6–8', 'North Indian feast for up to 12 guests, groceries extra'],
  Grills: ['Suya, ribs or grilled fish platter. Serves 6–8', 'Live grill at your event for up to 20 guests, groceries extra'],
};

const REVIEWS = {
  Nigerian: ['The jollof and peppered chicken had my guests asking for seconds.', 'Authentic flavours, arrived early and left the kitchen spotless.', 'Egusi and pounded yam just like home. Highly recommend.'],
  Japanese: ['The sushi was beautiful and tasted even better. Guests were stunned.', 'Professional, quiet and incredibly clean. The ramen was perfect.', 'An unforgettable birthday dinner. Worth every naira.'],
  Baking: ['The cake looked like a work of art and was moist all the way through.', 'Delivered on time, custom design exactly as I described.', 'Best pastries we have ever had at an event.'],
  Chinese: ['The dim sum disappeared in minutes. Authentic and fresh.', 'Great communication and a perfectly paced banquet.', 'The noodles were restaurant quality at home.'],
  Italian: ['Handmade pasta that tasted like Rome. The pizza was a hit too.', 'Warm, professional, and the tiramisu was unreal.', 'Everything was cooked fresh in our kitchen. Loved it.'],
  Continental: ['A real fine-dining evening without leaving the house.', 'Beautiful plating and every course was spot on.', 'Calm, organised and delicious. Would book again.'],
  Indian: ['The butter chicken and naan were outstanding. Spice level was perfect.', 'Generous portions and so many flavours. Guests loved the samosas.', 'Authentic biryani, cooked with real care.'],
  Grills: ['The suya was smoky, spicy and perfectly done. Event favourite!', 'Great grill master, kept the party going with fresh skewers.', 'Ribs fell off the bone. Brilliant.'],
};

// name, gender, cuisines (first is the main one), area, years, events, reply, prices [dish, event, hour], bio, tags
const CHEFS = [
  ['Adaeze Okafor', 'F', ['Nigerian', 'Continental'], 'Lekki', 12, 340, '~1 hr', [8500, 45000, 12000], 'Modern Nigerian cooking with a fine-dining finish. Ofada, asun canapés, smoked party jollof and a three-course tasting menu.', ['Jollof', 'Small chops', 'Tasting menu']],
  ['Ifeanyi Nwosu', 'M', ['Japanese'], 'Victoria Island', 8, 210, '~2 hrs', [12000, 60000, 18000], 'Sushi, ramen and izakaya small plates cooked at your table. Trained in Lagos and Osaka.', ['Sushi', 'Ramen', 'Izakaya']],
  ['Tunde Bakare', 'M', ['Baking'], 'Ikoyi', 6, 150, '~30 min', [8500, 40000, 10000], 'Celebration cakes, pastries and dessert tables for weddings, birthdays and corporate events.', ['Cakes', 'Pastry', 'Dessert tables']],
  ['Femi Ogunleye', 'M', ['Italian', 'Continental'], 'Ikeja', 10, 180, '~1 hr', [9000, 50000, 15000], 'Handmade pasta and slow-cooked Italian classics for intimate dinners.', ['Pasta', 'Pizza', 'Risotto']],
  ['Mei Lin Chen', 'F', ['Chinese'], 'Lekki', 5, 90, '~3 hrs', [7500, 40000, 11000], 'Sichuan and Cantonese home cooking. Dim sum parties are a speciality.', ['Dim sum', 'Sichuan', 'Noodles']],
  ['Amara Singh', 'F', ['Indian', 'Grills'], 'Surulere', 9, 200, '~1 hr', [8000, 35000, 12000], 'North Indian feasts and tandoor-style grills, from butter chicken to fresh naan.', ['Curry', 'Tandoori', 'Biryani']],
  ['Bolanle Adebayo', 'F', ['Nigerian'], 'Yaba', 15, 420, '~1 hr', [8000, 42000, 11000], 'Traditional Yoruba and Igbo kitchen: amala, egusi, efo riro and party rice done right.', ['Amala', 'Egusi', 'Party rice']],
  ['Chinedu Eze', 'M', ['Nigerian', 'Grills'], 'Surulere', 11, 260, '~45 min', [7500, 38000, 10000], 'Peppered snail, goat meat pepper soup and charcoal-grilled fish. Big flavours for big groups.', ['Pepper soup', 'Grilled fish', 'Swallow']],
  ['Kenji Tanaka', 'M', ['Japanese'], 'Ikoyi', 14, 300, '~2 hrs', [14000, 75000, 20000], 'Edomae-style sushi and robata grill. Quiet, precise and beautifully presented.', ['Omakase', 'Sashimi', 'Robata']],
  ['Yuki Nakamura', 'F', ['Japanese'], 'Lekki', 7, 130, '~1 hr', [11000, 55000, 16000], 'Home-style Japanese: ramen, katsu curry, onigiri and matcha desserts.', ['Ramen', 'Katsu', 'Matcha']],
  ['Folasade Ojo', 'F', ['Baking'], 'Ajah', 9, 240, '~1 hr', [7000, 35000, 9000], 'Custom wedding cakes, cupcakes and chin chin boxes with a Nigerian twist.', ['Wedding cakes', 'Cupcakes', 'Chin chin']],
  ['Grace Mensah', 'F', ['Baking'], 'Maryland', 5, 95, '~2 hrs', [6500, 32000, 9000], 'Bread, croissants and brunch pastries baked fresh the morning of your event.', ['Bread', 'Croissants', 'Brunch']],
  ['Wei Zhang', 'M', ['Chinese'], 'Victoria Island', 12, 280, '~1 hr', [9000, 52000, 14000], 'Cantonese banquets and live wok cooking. Peking duck on request.', ['Cantonese', 'Wok', 'Peking duck']],
  ['Jiahui Wong', 'F', ['Chinese'], 'Lekki', 6, 110, '~2 hrs', [7000, 38000, 10000], 'Handmade dumplings, hand-pulled noodles and hotpot nights at home.', ['Dumplings', 'Hotpot', 'Noodles']],
  ['Giulia Rossi', 'F', ['Italian'], 'Ikoyi', 13, 310, '~1 hr', [10000, 58000, 16000], 'Northern Italian cooking: fresh pasta, osso buco and a proper tiramisu.', ['Fresh pasta', 'Tiramisu', 'Osso buco']],
  ['Marco Bianchi', 'M', ['Italian'], 'Banana Island', 16, 360, '~2 hrs', [11000, 65000, 18000], 'Wood-fired style pizza and Roman classics for private dinners and events.', ['Pizza', 'Carbonara', 'Antipasti']],
  ['Oluwaseun Adeleke', 'M', ['Continental'], 'Victoria Island', 10, 230, '~1 hr', [9500, 55000, 15000], 'French-inspired private dining. Seared scallops, steak frites and chocolate fondant.', ['French', 'Steak', 'Fine dining']],
  ['Sarah Whitfield', 'F', ['Continental'], 'Lekki', 8, 170, '~1 hr', [9000, 48000, 14000], 'Light, seasonal menus: brunch boards, roast chicken dinners and canapés.', ['Brunch', 'Canapés', 'Roasts']],
  ['Daniel Okoro', 'M', ['Continental'], 'Magodo', 7, 140, '~3 hrs', [8500, 45000, 13000], 'Steakhouse classics and hearty family dinners, cooked to order.', ['Steak', 'Burgers', 'Family dinners']],
  ['Priya Sharma', 'F', ['Indian'], 'Ikoyi', 11, 250, '~1 hr', [8500, 42000, 13000], 'South and North Indian vegetarian and meat menus. Dosas, thalis and street-food parties.', ['Thali', 'Dosa', 'Vegetarian']],
  ['Rahul Mehta', 'M', ['Indian'], 'Ikeja', 9, 190, '~2 hrs', [8000, 40000, 12000], 'Mumbai street food and Mughlai biryani for celebrations of every size.', ['Biryani', 'Street food', 'Kebabs']],
  ['Musa Abubakar', 'M', ['Grills', 'Nigerian'], 'Gbagada', 18, 520, '~30 min', [6500, 36000, 9000], 'Authentic Kaduna-style suya, kilishi and grilled turkey. Fire and spice.', ['Suya', 'Kilishi', 'Turkey']],
  ['Kehinde Balogun', 'F', ['Grills'], 'Ajah', 8, 160, '~1 hr', [7000, 38000, 10000], 'Barbecue ribs, grilled prawns and fish platters for garden parties and weddings.', ['Ribs', 'Prawns', 'BBQ']],
  ['Emeka Obi', 'M', ['Grills', 'Nigerian'], 'Festac', 10, 210, '~45 min', [7000, 36000, 9500], 'Live grill station: catfish, chicken, plantain and spicy sauces made to order.', ['Catfish', 'Live grill', 'Plantain']],
];

const HIRERS = [
  { phone: '+2348100000001', firstName: 'Tobi', lastName: 'Adeyemi', email: 'tobi.adeyemi@example.com', address: '14 Admiralty Way, Lekki Phase 1, Lagos', lat: 6.4474, lng: 3.4723 },
  { phone: '+2348100000002', firstName: 'Ngozi', lastName: 'Eze', email: 'ngozi.eze@example.com', address: '22 Awolowo Road, Ikoyi, Lagos', lat: 6.4549, lng: 3.4346 },
  { phone: '+2348100000003', firstName: 'Kemi', lastName: 'Bello', email: 'kemi.bello@example.com', address: '5 Allen Avenue, Ikeja, Lagos', lat: 6.6018, lng: 3.3515 },
];

const jitter = (n, i) => Math.round((n + ((i % 7) - 3) * 0.002) * 1e6) / 1e6;
const phoneFor = (i) => `+23480000000${String(i + 1).padStart(2, '0')}`;

(async () => {
  try {
    await db.sequelize.authenticate();
    const counters = { F: 0, M: 0 };
    const perCuisine = {};
    const hirers = [];

    for (const h of HIRERS) {
      const [member] = await Member.findOrCreate({ where: { phone: h.phone }, defaults: { ...h, activeRole: 'hirer' } });
      await member.update({ firstName: h.firstName, lastName: h.lastName, email: h.email, address: h.address, lat: h.lat, lng: h.lng, avatarUrl: portrait(h.firstName === 'Tobi' ? 'M' : 'F', h.firstName === 'Tobi' ? 71 : h.firstName === 'Ngozi' ? 90 : 87) });
      hirers.push(member);
    }

    let refCounter = 11000;
    const stats = { chefs: 0, reviews: 0 };

    for (const [i, row] of CHEFS.entries()) {
      const [name, gender, cuisines, area, years, events, reply, prices, bio, tags] = row;
      const main = cuisines[0];
      perCuisine[main] = (perCuisine[main] || 0) + 1;
      const k = perCuisine[main] - 1; // 0,1,2 within the cuisine
      const pool = POOLS[main];
      const portfolio = [1, 2, 3, 4].map((n) => ({ url: photo(pool[(k * 2 + n) % pool.length]), caption: `${main} · ${name.split(' ')[0]}'s kitchen` }));
      const avatarNumber = 10 + counters[gender] * 3 + (gender === 'F' ? 0 : 1);
      counters[gender] += 1;
      const [first, ...rest] = name.split(' ');
      const [lat, lng] = AREAS[area];

      const [member] = await Member.findOrCreate({
        where: { phone: phoneFor(i) },
        defaults: { phone: phoneFor(i), firstName: first, lastName: rest.join(' '), activeRole: 'chef', isChef: true },
      });
      await member.update({
        firstName: first, lastName: rest.join(' '), isChef: true, activeRole: 'chef',
        email: `${first}.${rest.join('').replace(/\s/g, '')}@example.com`.toLowerCase(),
        avatarUrl: portrait(gender, avatarNumber), address: `${area}, Lagos`, lat: jitter(lat, i), lng: jitter(lng, i + 2),
      });

      const profileFields = {
        displayName: name, bio, cuisines, tags: [...new Set([...cuisines, ...tags])], yearsExperience: years, eventsCooked: events,
        replyTime: reply, area: `${area}, Lagos`, lat: jitter(lat, i), lng: jitter(lng, i + 2),
        coverUrl: photo(pool[(k * 2) % pool.length]), portfolio,
        verificationStatus: 'verified', verifiedAt: new Date(), available: true,
        startingPrice: Math.min(...prices),
        startingUnit: ['dish', 'event', 'hour'][prices.indexOf(Math.min(...prices))],
      };
      let chef = await ChefProfile.findOne({ where: { memberId: member.id } });
      if (chef) await chef.update(profileFields);
      else chef = await ChefProfile.create({ memberId: member.id, ...profileFields });

      // Menu: rebuilt on every run unless bookings already reference the existing services.
      if (!(await Booking.count({ where: { chefId: chef.id } }))) {
        await ChefService.destroy({ where: { chefId: chef.id } });
        const [dishCopy, eventCopy] = SERVICE_COPY[main];
        await ChefService.bulkCreate([
          { chefId: chef.id, title: 'Per dish', description: dishCopy, price: prices[0], unit: 'dish', icon: 'restaurant-outline', sortOrder: 0 },
          { chefId: chef.id, title: 'Private dinner', description: eventCopy, price: prices[1], unit: 'event', icon: 'sparkles-outline', sortOrder: 1 },
          { chefId: chef.id, title: 'Hourly cooking', description: 'Minimum 3 hours', price: prices[2], unit: 'hour', icon: 'time-outline', sortOrder: 2 },
        ]);
      }
      stats.chefs += 1;

      // Reviews: one completed, paid and released booking per demo hirer, each with a review.
      if (!(await BookingReview.count({ where: { chefId: chef.id } }))) {
        const service = await ChefService.findOne({ where: { chefId: chef.id, unit: 'event' } });
        const ratings = [5, 5, i % 3 === 0 ? 4 : 5];
        for (const [h, hirer] of hirers.entries()) {
          const pricing = computePricing({ unitPrice: service.price, quantity: 1, groceries: 15000 + h * 5000 });
          const when = new Date(Date.now() - (20 + h * 17 + (i % 9)) * 24 * 3600 * 1000);
          refCounter += 1;
          const booking = await Booking.create({
            reference: `HM-${refCounter}`, hirerId: hirer.id, chefId: chef.id, serviceId: service.id,
            serviceTitle: service.title, serviceUnit: service.unit, unitPrice: service.price, quantity: 1,
            scheduledAt: when, guests: 8 + h * 2, address: hirer.address, ...pricing, status: 'completed',
            paidAt: new Date(when.getTime() - 5 * 24 * 3600 * 1000), acceptedAt: new Date(when.getTime() - 4 * 24 * 3600 * 1000),
            startedAt: when, completedAt: new Date(when.getTime() + 4 * 3600 * 1000), approvedAt: new Date(when.getTime() + 6 * 3600 * 1000),
            releasedAt: new Date(when.getTime() + 6 * 3600 * 1000),
          });
          await BookingPayment.create({
            bookingId: booking.id, paystackReference: `homie-seed-${booking.reference.toLowerCase()}`, amount: pricing.total,
            status: 'released', paidAt: booking.paidAt, releasedAt: booking.releasedAt, payoutStatus: 'paid', payoutAmount: pricing.chefPayout, channel: 'card',
          });
          await BookingReview.create({ bookingId: booking.id, hirerId: hirer.id, chefId: chef.id, rating: ratings[h], comment: REVIEWS[main][h], createdAt: new Date(when.getTime() + 24 * 3600 * 1000) });
          stats.reviews += 1;
        }
        const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
        await chef.update({ ratingAvg: Math.round(avg * 100) / 100, ratingCount: ratings.length });
      }
      console.log(`${String(i + 1).padStart(2)}. ${name.padEnd(18)} ${cuisines.join(' + ').padEnd(22)} ${phoneFor(i)}`);
    }

    console.log(`\nChefs ready: ${stats.chefs}   New reviews: ${stats.reviews}`);
    console.log('Per cuisine:', Object.entries(perCuisine).map(([c, n]) => `${c} ${n}`).join(' · '));
    console.log('Hirers:', HIRERS.map((h) => `${h.firstName} ${h.phone}`).join(' · '));
    process.exit(0);
  } catch (error) {
    console.error('Seed failed:', error);
    process.exit(1);
  }
})();
