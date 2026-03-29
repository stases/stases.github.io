(() => {
  const elements = Array.isArray(window.PERIODIC_TABLE_DATA) ? window.PERIODIC_TABLE_DATA : [];
  const categories = Array.isArray(window.PERIODIC_TABLE_CATEGORIES) ? window.PERIODIC_TABLE_CATEGORIES : [];
  const shellLetters = ["K", "L", "M", "N", "O", "P", "Q", "R"];
  const EMBED_HEIGHT_MESSAGE = "periodic-table:height";
  const isEmbeddedView =
    document.documentElement.classList.contains("embed-mode") || window.self !== window.top;
  const BLOCK_COLORS = {
    s: "#2F6B6C",
    p: "#B7832F",
    d: "#A24D3F",
    f: "#687640",
  };
  const BLOCK_INDICES = {
    s: 0,
    p: 1,
    d: 2,
    f: 3,
  };
  const ORBITAL_LABELS = ["s", "p", "d", "f"];
  const ORBITAL_CAPACITIES = [2, 6, 10, 14];
  const DESCRIPTOR_GROUPS = [
    { start: 0, end: 7 },
    { start: 7, end: 26 },
    { start: 26, end: 30 },
    { start: 30, end: 34 },
  ];

  const refs = {
    grid: document.getElementById("periodicGrid"),
    legend: document.getElementById("categoryLegend"),
    tableScroll: document.querySelector(".table-scroll"),
    search: document.getElementById("elementSearch"),
    clearFilters: document.getElementById("clearFilters"),
    emptyState: document.getElementById("tableEmptyState"),
    detailCard: document.getElementById("detailCard"),
    detailKicker: document.getElementById("detailKicker"),
    detailTitle: document.getElementById("detailTitle"),
    detailCategory: document.getElementById("detailCategory"),
    statsGrid: document.getElementById("statsGrid"),
    detailConfigShort: document.getElementById("detailConfigShort"),
    detailConfigFull: document.getElementById("detailConfigFull"),
    outerElectronPill: document.getElementById("outerElectronPill"),
    shellChips: document.getElementById("shellChips"),
    subatomicReps: document.getElementById("subatomicReps"),
    valenceBars: document.getElementById("valenceBars"),
    pcaSignature: document.getElementById("pcaSignature"),
    detailBlurb: document.getElementById("detailBlurb"),
    atomCanvasWrap: document.getElementById("atomCanvasWrap"),
    atomCanvas: document.getElementById("atomCanvas"),
  };

  const buttonByNumber = new Map();
  const legendByCategory = new Map();
  const elementsByNumber = new Map(elements.map((element) => [element.number, element]));
  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let subatomicProfilesByNumber = new Map();

  const state = {
    selectedNumber: 32,
    activeCategory: null,
    searchQuery: "",
    reducedMotion: motionQuery.matches,
  };

  let animationFrame = null;
  let resizeObserver = null;
  let pageResizeObserver = null;
  let embedLayoutObserver = null;
  let embedHeightFrame = null;

  if (!elements.length || !refs.grid) {
    return;
  }

  try {
    subatomicProfilesByNumber = buildSubatomicProfiles(elements);
  } catch (error) {
    console.error("Failed to build periodic-table subatomic profiles.", error);
  }

  init();

  function init() {
    renderLegend();
    renderGrid();
    bindEvents();
    setupEmbedLayout();
    applyFilters();
    selectElement(state.selectedNumber, { updateFilters: false });
    setupEmbedBridge();
    setupAtomCanvas();
    if (state.reducedMotion) {
      drawAtom(0);
    } else {
      startAnimation();
    }
  }

  function renderLegend() {
    refs.legend.innerHTML = "";
    categories.forEach((category) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `legend-chip cat-${category.key}`;
      button.textContent = category.label;
      button.setAttribute("aria-pressed", "false");
      button.dataset.category = category.key;
      button.addEventListener("click", () => {
        state.activeCategory = state.activeCategory === category.key ? null : category.key;
        renderLegendState();
        applyFilters(true);
      });
      refs.legend.appendChild(button);
      legendByCategory.set(category.key, button);
    });
  }

  function renderLegendState() {
    legendByCategory.forEach((button, categoryKey) => {
      const isActive = state.activeCategory === categoryKey;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });
  }

  function renderGrid() {
    refs.grid.innerHTML = "";

    const lanthanideLabel = document.createElement("div");
    lanthanideLabel.className = "series-label";
    lanthanideLabel.style.gridColumn = "1 / span 2";
    lanthanideLabel.style.gridRow = "9";
    lanthanideLabel.innerHTML = "<strong>Lanthanides</strong><span>57–71</span>";
    refs.grid.appendChild(lanthanideLabel);

    const actinideLabel = document.createElement("div");
    actinideLabel.className = "series-label";
    actinideLabel.style.gridColumn = "1 / span 2";
    actinideLabel.style.gridRow = "10";
    actinideLabel.innerHTML = "<strong>Actinides</strong><span>89–103</span>";
    refs.grid.appendChild(actinideLabel);

    elements.forEach((element) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `element-card cat-${element.categoryBase}`;
      button.dataset.number = String(element.number);
      button.dataset.category = element.categoryBase;
      button.dataset.search = `${element.name} ${element.symbol} ${element.number}`.toLowerCase();
      button.style.gridColumn = String(element.x);
      button.style.gridRow = String(element.y);
      button.title = `${element.name} (${element.symbol})`;
      button.setAttribute(
        "aria-label",
        `${element.name}, atomic number ${element.number}, ${element.categoryLabel}`
      );

      button.innerHTML = `
        <span class="element-number">${element.number}</span>
        <span class="element-symbol">${element.symbol}</span>
        <span class="element-name">${element.name}</span>
      `;

      button.addEventListener("click", () => {
        selectElement(element.number);
      });

      buttonByNumber.set(element.number, button);
      refs.grid.appendChild(button);
    });
  }

  function bindEvents() {
    refs.search.addEventListener("input", (event) => {
      state.searchQuery = event.currentTarget.value.trim().toLowerCase();
      applyFilters(true);
    });

    refs.search.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        const firstVisible = getVisibleElements()[0];
        if (firstVisible) {
          selectElement(firstVisible.number);
        }
      }
    });

    refs.clearFilters.addEventListener("click", () => {
      state.searchQuery = "";
      state.activeCategory = null;
      refs.search.value = "";
      renderLegendState();
      applyFilters(true);
      refs.search.focus();
    });

    motionQuery.addEventListener("change", (event) => {
      state.reducedMotion = event.matches;
      if (state.reducedMotion) {
        stopAnimation();
        drawAtom(0);
      } else {
        startAnimation();
      }
    });

    window.addEventListener(
      "resize",
      () => {
        drawAtom();
        notifyEmbedHeight();
      },
      { passive: true }
    );
  }

  function selectElement(number, options = {}) {
    const { updateFilters = false } = options;
    if (!elementsByNumber.has(number)) {
      return;
    }

    state.selectedNumber = number;
    updateSelectionStyles();
    renderDetails();

    if (updateFilters) {
      applyFilters(false);
    }
  }

  function updateSelectionStyles() {
    buttonByNumber.forEach((button, number) => {
      const selected = number === state.selectedNumber;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }

  function applyFilters(syncSelection = false) {
    const visibleElements = getVisibleElements();
    const visibleNumbers = new Set(visibleElements.map((element) => element.number));

    buttonByNumber.forEach((button, number) => {
      const isVisible = visibleNumbers.has(number);
      button.classList.toggle("is-dimmed", !isVisible);
      button.setAttribute("aria-hidden", String(!isVisible));
    });

    refs.emptyState.classList.toggle("hidden", visibleElements.length > 0);

    if (syncSelection && visibleElements.length > 0 && !visibleNumbers.has(state.selectedNumber)) {
      state.selectedNumber = visibleElements[0].number;
      updateSelectionStyles();
      renderDetails();
    }

    if (!visibleElements.length) {
      refs.clearFilters.disabled = false;
      notifyEmbedHeight();
      return;
    }

    refs.clearFilters.disabled = !state.searchQuery && !state.activeCategory;
    notifyEmbedHeight();
  }

  function getVisibleElements() {
    return elements.filter((element) => {
      const categoryMatch = !state.activeCategory || element.categoryBase === state.activeCategory;
      const searchMatch =
        !state.searchQuery ||
        `${element.name} ${element.symbol} ${element.number}`
          .toLowerCase()
          .includes(state.searchQuery);

      return categoryMatch && searchMatch;
    });
  }

  function renderDetails() {
    const element = elementsByNumber.get(state.selectedNumber);
    if (!element) {
      return;
    }

    const outerElectrons = element.shells[element.shells.length - 1] || 0;
    const phaseText = element.phase ? toTitleCase(element.phase) : "Unknown phase";
    const blockText = `${element.block.toUpperCase()}-block`;

    refs.detailCard.className = `detail-card cat-${element.categoryBase}`;
    refs.detailKicker.textContent = `Atomic number ${element.number}`;
    refs.detailTitle.textContent = `${element.name} (${element.symbol})`;
    refs.detailCategory.textContent = `${element.categoryLabel} • ${phaseText} • ${blockText}`;
    refs.detailConfigShort.textContent = element.configShort || element.config;
    refs.detailConfigFull.textContent = element.config;
    refs.outerElectronPill.textContent = `${outerElectrons} outer electron${outerElectrons === 1 ? "" : "s"}`;
    refs.detailBlurb.textContent = buildNarrative(element);
    refs.statsGrid.setAttribute("aria-label", isEmbeddedView ? "Element summary" : "Element statistics");

    renderStats(element, outerElectrons);
    renderShells(element.shells);
    renderSubatomicRepresentations(element);

    if (state.reducedMotion) {
      drawAtom(0);
    }

    notifyEmbedHeight();
  }

  function renderStats(element, outerElectrons) {
    const stats = isEmbeddedView
      ? [
          ["Atomic no.", String(element.number)],
          ["Period", String(element.period)],
          ["Group", element.group ? String(element.group) : "—"],
          ["Block", `${element.block.toUpperCase()}-block`],
        ]
      : [
          ["Atomic no.", String(element.number)],
          ["Atomic mass", formatMass(element.mass)],
          ["Period", String(element.period)],
          ["Group", String(element.group)],
          ["Block", element.block.toUpperCase()],
          ["Phase", toTitleCase(element.phase)],
          ["Shells", String(element.shells.length)],
          ["Valence e⁻", String(outerElectrons)],
        ];

    refs.statsGrid.innerHTML = "";
    stats.forEach(([label, value]) => {
      const card = document.createElement("div");
      card.className = "stat-card";
      card.innerHTML = `
        <span class="stat-label">${label}</span>
        <span class="stat-value">${value}</span>
      `;
      refs.statsGrid.appendChild(card);
    });
  }

  function renderShells(shells) {
    refs.shellChips.innerHTML = "";
    shells.forEach((count, index) => {
      const chip = document.createElement("span");
      chip.className = "shell-chip";
      chip.innerHTML = `<strong>${shellLetters[index] || `n${index + 1}`}</strong><span>${count} e⁻</span>`;
      refs.shellChips.appendChild(chip);
    });
  }

  function renderSubatomicRepresentations(element) {
    if (!refs.valenceBars || !refs.pcaSignature) {
      return;
    }

    const profile = subatomicProfilesByNumber.get(element.number);
    if (!profile) {
      refs.valenceBars.innerHTML = "";
      refs.pcaSignature.innerHTML = "";
      return;
    }

    const accentColor = BLOCK_COLORS[element.block] || BLOCK_COLORS.p;
    const accentSoft = lightenHex(accentColor, 0.45);

    if (refs.subatomicReps) {
      refs.subatomicReps.style.setProperty("--subatomic-accent", accentColor);
      refs.subatomicReps.style.setProperty("--subatomic-accent-soft", accentSoft);
    }

    renderValenceBars(profile, accentColor);
    renderPcaSignature(profile, element, accentColor, accentSoft);
  }

  function renderValenceBars(profile, accentColor) {
    refs.valenceBars.innerHTML = "";

    const fragment = document.createDocumentFragment();
    profile.valenceCounts.forEach((count, index) => {
      const row = document.createElement("div");
      const label = document.createElement("span");
      const track = document.createElement("span");
      const fill = document.createElement("span");
      const countLabel = document.createElement("span");
      const capacity = ORBITAL_CAPACITIES[index];
      const fillWidth = capacity > 0 ? (Math.max(0, Math.min(count, capacity)) / capacity) * 100 : 0;

      row.className = "subatomic-bar-row";
      label.className = "subatomic-bar-label";
      track.className = "subatomic-bar-track";
      fill.className = "subatomic-bar-fill";
      countLabel.className = "subatomic-bar-count";

      label.textContent = ORBITAL_LABELS[index];
      fill.style.width = `${fillWidth}%`;
      fill.style.backgroundColor = accentColor;
      countLabel.textContent = `${count}/${capacity}`;

      track.appendChild(fill);
      row.append(label, track, countLabel);
      fragment.appendChild(row);
    });

    refs.valenceBars.appendChild(fragment);
  }

  function renderPcaSignature(profile, element, accentColor, accentSoft) {
    refs.pcaSignature.innerHTML = "";
    refs.pcaSignature.setAttribute("aria-label", `PCA24 signature for ${element.name}`);

    const frame = document.createElement("div");
    const plot = document.createElement("div");
    const baseline = document.createElement("span");
    const bars = document.createElement("div");
    const ticks = document.createElement("div");
    const tickValues = [1, 8, 16, 24];
    const maxMagnitude = profile.signature.reduce(
      (largest, value) => Math.max(largest, Math.abs(value)),
      0.55
    );

    frame.className = "pca-signature-frame";
    plot.className = "pca-signature-plot";
    baseline.className = "pca-signature-baseline";
    bars.className = "pca-signature-bars";
    ticks.className = "pca-signature-ticks";

    plot.appendChild(baseline);

    tickValues.forEach((tick) => {
      const guide = document.createElement("span");
      guide.className = "pca-signature-guide";
      guide.style.left = `${(tick / profile.signature.length) * 100}%`;
      plot.appendChild(guide);
    });

    profile.signature.forEach((value) => {
      const slot = document.createElement("span");
      const bar = document.createElement("span");

      slot.className = "pca-signature-slot";
      bar.className = `pca-signature-bar ${value >= 0 ? "is-positive" : "is-negative"}`;
      bar.style.height = `${(Math.abs(value) / maxMagnitude) * 46}%`;
      bar.style.backgroundColor = value >= 0 ? accentColor : accentSoft;

      slot.appendChild(bar);
      bars.appendChild(slot);
    });

    tickValues.forEach((tick) => {
      const label = document.createElement("span");
      label.textContent = String(tick);
      label.style.gridColumn = String(Math.min(tick, profile.signature.length));

      if (tick === 1) {
        label.classList.add("is-start");
      }

      if (tick === profile.signature.length) {
        label.classList.add("is-end");
      }

      ticks.appendChild(label);
    });

    plot.appendChild(bars);
    frame.append(plot, ticks);
    refs.pcaSignature.appendChild(frame);
  }

  function buildSubatomicProfiles(items) {
    const descriptorTable = [];
    const profileRows = [];

    items.forEach((element) => {
      const parsedCounts = parseValenceCounts(element.configShort || element.config);
      const valenceCounts = ORBITAL_LABELS.map((label) => parsedCounts[label] || 0);

      descriptorTable.push(buildChemDescriptor(element, valenceCounts));
      profileRows.push({
        number: element.number,
        valenceCounts,
      });
    });

    const signatures = buildPcaSignatures(descriptorTable, 24);
    return new Map(
      profileRows.map((profile, index) => [
        profile.number,
        {
          valenceCounts: profile.valenceCounts,
          valenceFractions: profile.valenceCounts.map(
            (count, orbitalIndex) => count / ORBITAL_CAPACITIES[orbitalIndex]
          ),
          signature: signatures[index] || new Array(24).fill(0),
        },
      ])
    );
  }

  function parseValenceCounts(configText) {
    const counts = {
      s: 0,
      p: 0,
      d: 0,
      f: 0,
    };
    const normalized = String(configText || "")
      .replace(/\[[^\]]+\]/g, "")
      .replace(/\*/g, "")
      .replace(/\s+/g, "");
    const pattern = /(\d)([spdf])(\d+)(?=(?:\d[spdf])|$)/g;
    let match = pattern.exec(normalized);

    while (match) {
      counts[match[2]] += Number.parseInt(match[3], 10);
      match = pattern.exec(normalized);
    }

    return counts;
  }

  function buildChemDescriptor(element, valenceCounts) {
    const descriptor = new Array(34).fill(0);
    const period = Math.min(7, Math.max(1, Number(element.period) || 1));
    const descriptorGroup =
      element.block === "f" ? 0 : Math.min(18, Math.max(0, Number(element.group) || 0));
    const blockIndex = BLOCK_INDICES[element.block] ?? BLOCK_INDICES.p;

    descriptor[period - 1] = 1;
    descriptor[7 + descriptorGroup] = 1;
    descriptor[26 + blockIndex] = 1;

    valenceCounts.forEach((count, orbitalIndex) => {
      descriptor[30 + orbitalIndex] = Math.max(
        0,
        Math.min(1, count / ORBITAL_CAPACITIES[orbitalIndex])
      );
    });

    return descriptor;
  }

  function buildPcaSignatures(descriptorTable, outputDimensions) {
    if (!descriptorTable.length) {
      return [];
    }

    const { weighted } = standardizeAndWeightDescriptors(descriptorTable);
    const covariance = computeCovarianceMatrix(weighted);
    const { eigenvalues, eigenvectors } = jacobiEigenDecomposition(covariance);
    const descriptorDimensions = weighted[0].length;
    const componentCount = Math.min(outputDimensions, descriptorDimensions);
    const order = eigenvalues
      .map((value, index) => ({ value, index }))
      .sort((left, right) => right.value - left.value)
      .map((entry) => entry.index);
    const components = Array.from(
      { length: descriptorDimensions },
      () => new Array(componentCount).fill(0)
    );

    for (let componentIndex = 0; componentIndex < componentCount; componentIndex += 1) {
      const eigenIndex = order[componentIndex];
      for (let rowIndex = 0; rowIndex < descriptorDimensions; rowIndex += 1) {
        components[rowIndex][componentIndex] = eigenvectors[rowIndex][eigenIndex];
      }
    }

    for (let componentIndex = 0; componentIndex < componentCount; componentIndex += 1) {
      let pivotIndex = 0;
      let pivotMagnitude = 0;

      for (let rowIndex = 0; rowIndex < descriptorDimensions; rowIndex += 1) {
        const magnitude = Math.abs(components[rowIndex][componentIndex]);
        if (magnitude > pivotMagnitude) {
          pivotMagnitude = magnitude;
          pivotIndex = rowIndex;
        }
      }

      if (components[pivotIndex][componentIndex] < 0) {
        for (let rowIndex = 0; rowIndex < descriptorDimensions; rowIndex += 1) {
          components[rowIndex][componentIndex] *= -1;
        }
      }
    }

    return weighted.map((row) => {
      const projected = new Array(componentCount).fill(0);
      for (let componentIndex = 0; componentIndex < componentCount; componentIndex += 1) {
        let total = 0;
        for (let channelIndex = 0; channelIndex < descriptorDimensions; channelIndex += 1) {
          total += row[channelIndex] * components[channelIndex][componentIndex];
        }
        projected[componentIndex] = total;
      }

      const norm = vectorNorm(projected) || 1;
      return projected.map((value) => value / norm);
    });
  }

  function standardizeAndWeightDescriptors(descriptorTable) {
    const rowCount = descriptorTable.length;
    const columnCount = descriptorTable[0].length;
    const mean = new Array(columnCount).fill(0);
    const std = new Array(columnCount).fill(0);

    descriptorTable.forEach((row) => {
      row.forEach((value, columnIndex) => {
        mean[columnIndex] += value;
      });
    });

    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      mean[columnIndex] /= rowCount;
    }

    descriptorTable.forEach((row) => {
      row.forEach((value, columnIndex) => {
        const diff = value - mean[columnIndex];
        std[columnIndex] += diff * diff;
      });
    });

    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const sigma = Math.sqrt(std[columnIndex] / rowCount);
      std[columnIndex] = sigma > 1e-6 ? sigma : 1;
    }

    const weighted = descriptorTable.map((row) =>
      row.map((value, columnIndex) => (value - mean[columnIndex]) / std[columnIndex])
    );

    DESCRIPTOR_GROUPS.forEach(({ start, end }) => {
      const weight = (end - start) ** -0.5;
      weighted.forEach((row) => {
        for (let columnIndex = start; columnIndex < end; columnIndex += 1) {
          row[columnIndex] *= weight;
        }
      });
    });

    return { mean, std, weighted };
  }

  function computeCovarianceMatrix(matrix) {
    const columnCount = matrix[0].length;
    const covariance = Array.from({ length: columnCount }, () => new Array(columnCount).fill(0));

    matrix.forEach((row) => {
      for (let leftIndex = 0; leftIndex < columnCount; leftIndex += 1) {
        for (let rightIndex = leftIndex; rightIndex < columnCount; rightIndex += 1) {
          covariance[leftIndex][rightIndex] += row[leftIndex] * row[rightIndex];
        }
      }
    });

    for (let leftIndex = 0; leftIndex < columnCount; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < columnCount; rightIndex += 1) {
        covariance[rightIndex][leftIndex] = covariance[leftIndex][rightIndex];
      }
    }

    return covariance;
  }

  function jacobiEigenDecomposition(matrix) {
    const size = matrix.length;
    const working = matrix.map((row) => row.slice());
    const eigenvectors = Array.from({ length: size }, (_, rowIndex) =>
      Array.from({ length: size }, (_, columnIndex) => (rowIndex === columnIndex ? 1 : 0))
    );
    const tolerance = 1e-10;
    const maxSweeps = 80;

    for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
      let maxOffDiagonal = 0;

      for (let p = 0; p < size - 1; p += 1) {
        for (let q = p + 1; q < size; q += 1) {
          const entry = working[p][q];
          const magnitude = Math.abs(entry);
          if (magnitude > maxOffDiagonal) {
            maxOffDiagonal = magnitude;
          }

          if (magnitude <= tolerance) {
            continue;
          }

          const app = working[p][p];
          const aqq = working[q][q];
          const tau = (aqq - app) / (2 * entry);
          const t =
            tau === 0
              ? 1
              : Math.sign(tau) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
          const cosine = 1 / Math.sqrt(1 + t * t);
          const sine = t * cosine;

          for (let index = 0; index < size; index += 1) {
            if (index === p || index === q) {
              continue;
            }

            const valueP = working[index][p];
            const valueQ = working[index][q];
            const rotatedP = cosine * valueP - sine * valueQ;
            const rotatedQ = cosine * valueQ + sine * valueP;

            working[index][p] = rotatedP;
            working[p][index] = rotatedP;
            working[index][q] = rotatedQ;
            working[q][index] = rotatedQ;
          }

          working[p][p] = cosine * cosine * app - 2 * sine * cosine * entry + sine * sine * aqq;
          working[q][q] = sine * sine * app + 2 * sine * cosine * entry + cosine * cosine * aqq;
          working[p][q] = 0;
          working[q][p] = 0;

          for (let index = 0; index < size; index += 1) {
            const vectorP = eigenvectors[index][p];
            const vectorQ = eigenvectors[index][q];
            eigenvectors[index][p] = cosine * vectorP - sine * vectorQ;
            eigenvectors[index][q] = sine * vectorP + cosine * vectorQ;
          }
        }
      }

      if (maxOffDiagonal <= tolerance) {
        break;
      }
    }

    return {
      eigenvalues: Array.from({ length: size }, (_, index) => Math.max(working[index][index], 0)),
      eigenvectors,
    };
  }

  function vectorNorm(values) {
    let total = 0;
    values.forEach((value) => {
      total += value * value;
    });
    return Math.sqrt(total);
  }

  function lightenHex(color, amount) {
    const normalized = String(color || "").trim().replace("#", "");
    const hex =
      normalized.length === 3
        ? normalized
            .split("")
            .map((character) => character + character)
            .join("")
        : normalized;

    if (!/^[0-9a-f]{6}$/i.test(hex)) {
      return color;
    }

    const channels = [0, 2, 4].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
    const mixed = channels.map((channel) =>
      Math.round((1 - amount) * 255 + amount * channel)
    );

    return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  }

  function buildNarrative(element) {
    const outerElectrons = element.shells[element.shells.length - 1] || 0;
    const shellText = element.shells.join(" • ");
    const groupText =
      element.categoryBase === "lanthanide" || element.categoryBase === "actinide"
        ? `the ${element.categoryLabel.toLowerCase()} series`
        : `group ${element.group}`;

    return `${element.name} sits in period ${element.period}, ${groupText}, and the ${element.block}-block. ` +
      `Its shell distribution is ${shellText}, giving it ${outerElectrons} electron${outerElectrons === 1 ? "" : "s"} ` +
      `in the outermost shell. Swap this paragraph in app.js for your own product copy, lesson notes, ` +
      `portfolio text, or extra links.`;
  }

  function formatMass(value) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return "—";
    }

    const formatter = new Intl.NumberFormat("en-US", {
      maximumFractionDigits: value >= 100 ? 3 : 4,
    });

    return `${formatter.format(value)} u`;
  }

  function toTitleCase(value) {
    return String(value || "")
      .split(" ")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  }

  function setupAtomCanvas() {
    if (!window.ResizeObserver) {
      drawAtom(0);
      return;
    }

    resizeObserver = new ResizeObserver(() => {
      drawAtom(0);
      notifyEmbedHeight();
    });

    resizeObserver.observe(refs.atomCanvasWrap);
  }

  function setupEmbedBridge() {
    if (!isEmbeddedView || !window.parent || window.parent === window) {
      return;
    }

    if (window.ResizeObserver) {
      pageResizeObserver = new ResizeObserver(() => {
        notifyEmbedHeight();
      });
      pageResizeObserver.observe(document.documentElement);
      pageResizeObserver.observe(document.body);
    }

    window.addEventListener("load", notifyEmbedHeight, { once: true });
    notifyEmbedHeight();
  }

  function setupEmbedLayout() {
    if (!isEmbeddedView || !refs.grid || !refs.tableScroll) {
      return;
    }

    syncEmbedGridSize();

    if (!window.ResizeObserver) {
      return;
    }

    embedLayoutObserver = new ResizeObserver(() => {
      syncEmbedGridSize();
      notifyEmbedHeight();
    });

    embedLayoutObserver.observe(refs.tableScroll);
  }

  function syncEmbedGridSize() {
    if (!isEmbeddedView || !refs.grid || !refs.tableScroll) {
      return;
    }

    const availableWidth = refs.tableScroll.clientWidth;
    if (!availableWidth) {
      return;
    }

    const gridStyles = window.getComputedStyle(refs.grid);
    const gap = Number.parseFloat(gridStyles.columnGap || gridStyles.gap || "0") || 0;
    const columns = 18;
    const tileSize = (availableWidth - gap * (columns - 1)) / columns;

    if (!Number.isFinite(tileSize) || tileSize <= 0) {
      return;
    }

    refs.grid.style.setProperty("--tile-size", `${tileSize}px`);
  }

  function notifyEmbedHeight() {
    if (!isEmbeddedView || !window.parent || window.parent === window) {
      return;
    }

    if (embedHeightFrame) {
      return;
    }

    embedHeightFrame = window.requestAnimationFrame(() => {
      embedHeightFrame = null;

      const root = document.documentElement;
      const body = document.body;
      const pageShell = document.querySelector(".page-shell");
      const shellHeight = pageShell
        ? Math.ceil(
            Math.max(
              pageShell.getBoundingClientRect().height || 0,
              pageShell.scrollHeight || 0,
              pageShell.offsetHeight || 0
            )
          )
        : 0;
      const documentHeight = Math.ceil(
        Math.max(
          root ? root.scrollHeight : 0,
          root ? root.offsetHeight : 0,
          body ? body.scrollHeight : 0,
          body ? body.offsetHeight : 0
        )
      );
      const height = shellHeight > 0 ? shellHeight : documentHeight;

      window.parent.postMessage(
        {
          type: EMBED_HEIGHT_MESSAGE,
          height,
        },
        "*"
      );
    });
  }

  function startAnimation() {
    if (animationFrame) {
      return;
    }

    const tick = (timestamp) => {
      drawAtom(timestamp);
      animationFrame = window.requestAnimationFrame(tick);
    };

    animationFrame = window.requestAnimationFrame(tick);
  }

  function stopAnimation() {
    if (animationFrame) {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
  }

  function drawAtom(timestamp = 0) {
    const element = elementsByNumber.get(state.selectedNumber);
    const canvas = refs.atomCanvas;
    if (!canvas || !element) {
      return;
    }

    const rect = refs.atomCanvasWrap.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;
    const maxDimension = Math.min(width, height);
    const shells = element.shells;
    const nucleusRadius = Math.max(16, maxDimension * 0.065);
    const firstRadius = nucleusRadius + maxDimension * 0.12;
    const maxRadius = maxDimension * 0.42;
    const radiusStep = shells.length > 1 ? (maxRadius - firstRadius) / (shells.length - 1) : 0;

    drawBackgroundGlow(ctx, cx, cy, maxDimension);

    shells.forEach((count, shellIndex) => {
      const radius = firstRadius + radiusStep * shellIndex;
      const ry = radius * (0.42 + shellIndex * 0.015);
      const rotation = ((shellIndex * 24) + 12) * (Math.PI / 180);
      const speedDirection = shellIndex % 2 === 0 ? 1 : -1;
      const angularSpeed = state.reducedMotion ? 0 : (0.00015 + shellIndex * 0.00003) * speedDirection;
      const electronRadius = Math.max(2.2, 4.8 - shellIndex * 0.35);

      ctx.beginPath();
      ctx.ellipse(cx, cy, radius, ry, rotation, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(15, 23, 42, 0.10)";
      ctx.stroke();

      for (let electronIndex = 0; electronIndex < count; electronIndex += 1) {
        const baseAngle = (Math.PI * 2 * electronIndex) / count;
        const angle = baseAngle + timestamp * angularSpeed;
        const point = ellipsePoint(cx, cy, radius, ry, rotation, angle);

        ctx.beginPath();
        ctx.arc(point.x, point.y, electronRadius, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(73, 102, 255, 0.92)";
        ctx.shadowColor = "rgba(73, 102, 255, 0.25)";
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    });

    drawNucleus(ctx, cx, cy, nucleusRadius);
  }

  function drawBackgroundGlow(ctx, cx, cy, maxDimension) {
    const glow = ctx.createRadialGradient(cx, cy, maxDimension * 0.02, cx, cy, maxDimension * 0.5);
    glow.addColorStop(0, "rgba(255, 255, 255, 0.88)");
    glow.addColorStop(0.55, "rgba(255, 255, 255, 0.38)");
    glow.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, maxDimension * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawNucleus(ctx, cx, cy, radius) {
    const gradient = ctx.createRadialGradient(cx - radius * 0.3, cy - radius * 0.3, radius * 0.2, cx, cy, radius);
    gradient.addColorStop(0, "rgba(255, 206, 170, 0.98)");
    gradient.addColorStop(0.45, "rgba(255, 135, 108, 0.95)");
    gradient.addColorStop(1, "rgba(233, 82, 82, 0.96)");

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    const highlight = ctx.createRadialGradient(cx - radius * 0.35, cy - radius * 0.35, 0, cx - radius * 0.35, cy - radius * 0.35, radius * 0.8);
    highlight.addColorStop(0, "rgba(255, 255, 255, 0.7)");
    highlight.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = highlight;
    ctx.beginPath();
    ctx.arc(cx - radius * 0.18, cy - radius * 0.14, radius * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }

  function ellipsePoint(cx, cy, rx, ry, rotation, angle) {
    const x = rx * Math.cos(angle);
    const y = ry * Math.sin(angle);

    return {
      x: cx + (x * Math.cos(rotation) - y * Math.sin(rotation)),
      y: cy + (x * Math.sin(rotation) + y * Math.cos(rotation)),
    };
  }
})();
