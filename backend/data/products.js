// Seed catalogue. `image` is a file name inside server/data/images/.
// Running `npm run db:seed` converts each image and stores it in Neon (only if missing).
// The original release date of the catalogue (used so these aren't labelled "New").
export const ORIGINAL_RELEASE = '2026-03-30T00:00:00Z';
// Default stock per size for products that have no sizes yet. Adjust real numbers in the owner editor.
export const DEFAULT_SIZES = ['S', 'M', 'L', 'XL', 'XXL'];
export const DEFAULT_STOCK = 10;
export const products = [
    { id: 901, category: 'Collabs', slug: 'initial-d-drift-tee', title: 'Initial D Drift Tee', price: 1100, image: 'Paradigm x Initial D unfinished.jpg',
      desc: "Paradigm x Initial D, ft. Takumi's AE86, Takahashi's RX7, and The Mako's Sileighties." },
    { id: 902, category: 'Originals', slug: 'prdgm-26-tee', title: 'PRDGM 26 Tee', price: 900, image: 'Paradigm Varsity Shirt unfinished.png',
      desc: 'Classic Collegiate Varsity fit with heavyweight cotton.' },
    { id: 903, category: 'Collabs', slug: 'snoopy-v1-tee', title: 'Snoopy V1 Tee', price: 1300, image: 'Paradigm x Snoopy.png',
      desc: 'Paradigm x Snoopy V1, ft. Peanuts, Snoopy on a Skateboard with Woodstock.' },
    { id: 904, category: 'Collabs', slug: 'snoopy-v2-tee', title: 'Snoopy V2 Tee', price: 1400, image: 'Paradigm x Snoopy V2.png',
      desc: 'Paradigm x Snoopy V2, ft. Peanuts, Snoopy playing soccer/football with Woodstock.' },
    { id: 905, category: 'Collabs', slug: 'strawberry-shortcake-tee', title: 'Strawberry Shortcake Tee', price: 1500, image: 'Paradigm x Strawberry Shortcake.png',
      desc: 'Paradigm x Strawberry Shortcake Tee.' },
    { id: 906, category: 'JDM', slug: 'jdm-fit-tee', title: 'JDM Fit Tee', price: 1200, image: 'Paradigm Fit.png',
      desc: 'Classic JDM Tee, Inspired by the Honda GD2 4WD variant.' },
    { id: 907, category: 'Collabs', slug: 'akatsuki-tee', title: 'Akatsuki Tee', price: 1000, image: 'Paradigm x Naruto.jpeg',
      desc: 'Paradigm x Naruto Tee.' },
    { id: 911, category: 'Originals', slug: 'cultural-statuesque-tee', title: 'Cultural Statuesque Tee', price: 1300, image: 'Paradigm Cultural Statuesque.jpeg',
      desc: 'Classical art meets modern street silhouettes.' },
    { id: 912, category: 'Originals', slug: 'oni-tee', title: 'Oni Tee', price: 1200, image: 'Paradigm Oni.jpeg',
      desc: 'Folklore-inspired graphic with high-contrast detailing.' },
    { id: 913, category: 'Originals', slug: 'the-dream-tee', title: 'The Dream Tee', price: 1100, image: 'Paradigm The Dream.jpeg',
      desc: "Surrealist archive print from the 'Cloudscape' collection." },
    { id: 914, category: 'Collabs', slug: 'sanrio-duo-tee', title: 'Sanrio Duo Tee', price: 3000, image: 'Paradigm x Sanrio Melody & Kuromi.jpeg',
      desc: 'Paradigm x Melody & Kuromi collaboration Tee.' },
    { id: 915, category: 'Originals', slug: 'skelly-tee', title: 'Skelly Tee', price: 900, image: 'Paradigm Skelly.jpeg',
      desc: 'Anatomically Sad Skeleton Print Tee.' },
    { id: 916, category: 'Originals', slug: 'night-tee', title: 'Night Tee', price: 800, image: 'Paradigm Night.jpeg',
      desc: 'Up all night, with Paradigm Night Tee!' },
    { id: 917, category: 'Collabs', slug: 'sanrio-melody-tee', title: 'Sanrio Melody Tee', price: 1000, image: 'Paradigm x Sanrio Melody.jpeg',
      desc: 'Soft-touch cotton Tee featuring My Melody.' },
    { id: 918, category: 'Originals', slug: 'sharky-tee', title: 'Sharky Tee', price: 950, image: 'Paradigm Sharky.jpeg',
      desc: 'Cute Little Sharks Tee' },
    { id: 919, category: 'Originals', slug: 'daily-tee', title: 'Daily Tee', price: 1050, image: 'Paradigm Daily.jpeg',
      desc: 'Essential wear for the 2026 Archive rotation.' },
    { id: 920, category: 'Collabs', slug: 'evangelion-tee', title: 'Evangelion Tee', price: 1100, image: 'Paradigm x Evangelion.jpeg',
      desc: 'Paradigm x Evangelion Tee.' },
    { id: 921, category: 'Originals', slug: 'catto-tee', title: 'Catto Tee', price: 800, image: 'Paradigm Catto.jpeg',
      desc: 'For those who love Cattos.' },
    { id: 922, category: 'Originals', slug: 'y2k-girl-tee', title: 'Y2k Girl Tee', price: 850, image: 'Paradigm Y2k Girl.jpeg',
      desc: 'Retro-futuristic aesthetic inspired by digital culture.' },
];
