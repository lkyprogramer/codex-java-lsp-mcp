import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.HashSet;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import org.eclipse.core.runtime.IPath;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.search.SearchEngine;
import org.eclipse.jdt.internal.compiler.env.AutomaticModuleNaming;
import org.eclipse.jdt.internal.compiler.util.Util;
import org.eclipse.jdt.internal.core.index.DiskIndex;
import org.eclipse.jdt.internal.core.index.FileIndexLocation;
import org.eclipse.jdt.internal.core.index.Index;
import org.eclipse.jdt.internal.core.search.JavaSearchDocument;
import org.eclipse.jdt.internal.core.search.indexing.BinaryContainer;
import org.eclipse.jdt.internal.core.search.indexing.BinaryIndexer;
import org.eclipse.jdt.internal.core.search.indexing.ManifestIndexer;

/** Builds only the external JAR portion of the frozen JDT search index. */
public final class Ilv2JarIndex extends BinaryContainer {
    private static final String AUTOMATIC_MODULE_NAME = "Automatic-Module-Name";
    private final Path output;

    private Ilv2JarIndex(IPath jar, Path output) {
        // Reuse the runtime entry filter without starting the Eclipse workspace or queue.
        super(jar, null);
        this.output = output;
    }

    @Override
    public boolean execute(IProgressMonitor monitor) {
        try {
            writeIndex();
            return true;
        } catch (IOException error) {
            throw new UncheckedIOException("JDT index generation failed for " + containerPath, error);
        }
    }

    private void writeIndex() throws IOException {
        var participant = SearchEngine.getDefaultSearchParticipant();
        var location = new FileIndexLocation(output.toFile());
        var index = new Index(location, containerPath.toOSString(), false);
        index.separator = '|';
        boolean module = false;
        try (var zip = new ZipFile(containerPath.toFile())) {
            var entries = zip.entries();
            while (entries.hasMoreElements()) {
                var entry = entries.nextElement();
                String name = entry.getName();
                if (!Util.isClassFileName(name) || !isValidPackageNameForClassOrisModule(name)) continue;
                module |= name.contains("module-info");
                var document = new JavaSearchDocument(entry, containerPath, Util.getZipEntryByteContent(entry, zip), participant);
                document.setIndex(index);
                new BinaryIndexer(document).indexDocument();
            }
            if (!module) {
                char[] name = AutomaticModuleNaming.determineAutomaticModuleName(containerPath.toOSString());
                byte[] contents = (AUTOMATIC_MODULE_NAME + ":" + new String(name)).getBytes(Charset.defaultCharset());
                var document = new JavaSearchDocument(new ZipEntry(AUTOMATIC_MODULE_NAME), containerPath, contents, participant);
                document.setIndex(index);
                new ManifestIndexer(document).indexDocument();
            }
        }
        if (!index.save()) throw new IllegalStateException("Empty JDT index for " + containerPath);
        var reopened = new Index(location, containerPath.toOSString(), true);
        String[] documents = reopened.queryDocumentNames("");
        if (!reopened.isIndexForJar() || documents == null || documents.length == 0) {
            throw new IllegalStateException("Unreadable JDT index for " + containerPath);
        }
        Files.setLastModifiedTime(output, Files.getLastModifiedTime(containerPath.toFile().toPath()));
    }

    public static void main(String[] args) throws Exception {
        String version = DiskIndex.SIGNATURE.substring("INDEX VERSION ".length());
        Path output = Files.createDirectory(Path.of(args[1]).resolve(version));
        var names = new HashSet<String>();
        System.out.println(version);
        for (String line : Files.readAllLines(Path.of(args[0]))) {
            String jar = new String(Base64.getDecoder().decode(line), StandardCharsets.UTF_8);
            IPath container = org.eclipse.core.runtime.Path.fromOSString(jar);
            var crc = new CRC32();
            crc.update(container.toPortableString().getBytes(Charset.defaultCharset()));
            String name = crc.getValue() + ".index";
            if (!names.add(name)) throw new IllegalStateException("JDT index path collision: " + jar);
            new Ilv2JarIndex(container, output.resolve(name)).execute(null);
            System.out.println(name);
        }
    }
}
