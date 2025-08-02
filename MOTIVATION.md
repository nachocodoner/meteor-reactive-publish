## Motivation

Back in the day, there were several ways to improve Meteor reactivity in publications. One of my favorites was being able to publish multiple sets of documents from different collections reactively. Among the options, _[**reywood:publish-composite**](https://github.com/Meteor-Community-Packages/meteor-publish-composite)_ was the most popular, and still available thanks to community maintainers in **Meteor 3**. But my preferred choice, the one I used in all past projects, is _[**peerlibrary:reactive-publish**](https://github.com/peerlibrary/meteor-reactive-publish)_.

**_peerlibrary:reactive-publish_** relies on Meteor’s core concepts, using **Tracker’s `autorun`** on the server to automatically **track cursors** and ensure all used cursors, including those derived from others, respond to changes and **publish related documents** correctly. Using **`autorun` blocks** also makes code **reusable**: the logic inside a server publication often matches what’s expected on the client when querying. This **avoids separate structures to define query dependencies**, as other solutions require (publish-composite). This approach stays true to Meteor’s goal of being **isomorphic and reactive** with **Tracker and ReactiveVar usage**, this time enabled for **missing Mongo APIs** and **async tasks**.

This work comes from individual motivation. Meteor Core has its own roadmap and priorities. I work part-time with the core team. The rest of my time goes into building real apps, staying close to the Meteor user experience, and making sure these apps and libraries are ready for Meteor 3. I also spend time on creative and experimental work, exploring concepts in isolation to bring future benefits.

I’ve used **[peerlibrary's libraries](https://github.com/peerlibrary)** in my own projects, so I’m putting in time to bring them into Meteor 3. I've felt inspired for long on how this library handles and expands reactivity on Meteor. Over the years, it's been a bit discouraging to see that the community hasn't shown much interest in bringing these ideas back. Since I see the value in these concepts, I decided to do the work to ensure they remain available for modern Meteor times.

I know others were blocked on the Meteor 3 migration due to this library compatibility; now they can adopt it. I started by reaching out to **[@mitan](https://github.com/mitar)**, [who gave permission for the update](https://github.com/peerlibrary/meteor-reactive-publish/issues/54#issuecomment-2124539215). Migrating this package was a long effort because its codebase and technical concepts are complex. The results are great: it unblocks Meteor 2 apps to move to Meteor 3 and preserves the reactive approach’s potential.

A quick snapshot of what’s been achieved so far: migrating several interdependent **peerlibrary packages** written in **Coffeescript** to modern **Javascript**, closely tied to **Meteor Tracker** and reactivity, and using **fibers**. This involved careful async migration to **Node standards**, updating the **test setup** from a custom framework to **TinyTest**, and adjusting many tests until they passed one by one. Test coverage was **expanded and performance considered**.

Next steps are to improve stability and gather performance data. However, peerlibrary's packages explored more concepts, such as those in _[**peerlibrary:subscribe-data**](https://github.com/peerlibrary/meteor-subscription-data)_, including the ability to publish any data reactively using Meteor's built-in system.

🗺️ [Review the roadmap](./README.md#roadmap) to see the future plans for this library.

☄️ **Keep going with Meteor 3 and building cool apps!**
